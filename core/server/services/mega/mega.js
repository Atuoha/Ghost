const _ = require('lodash');
const debug = require('ghost-ignition').debug('mega');
const url = require('url');
const moment = require('moment');
const ObjectId = require('bson-objectid');
const errors = require('@tryghost/errors');
const {events, i18n} = require('../../lib/common');
const logging = require('../../../shared/logging');
const membersService = require('../members');
const bulkEmailService = require('../bulk-email');
const jobService = require('../jobs');
const models = require('../../models');
const db = require('../../data/db');
const postEmailSerializer = require('./post-email-serializer');

const getEmailData = async (postModel, memberRows = []) => {
    const startTime = Date.now();
    debug(`getEmailData: starting for ${memberRows.length} members`);
    const {emailTmpl, replacements} = await postEmailSerializer.serialize(postModel);

    emailTmpl.from = membersService.config.getEmailFromAddress();
    emailTmpl.supportAddress = membersService.config.getEmailSupportAddress();

    // update templates to use Mailgun variable syntax for replacements
    replacements.forEach((replacement) => {
        emailTmpl[replacement.format] = emailTmpl[replacement.format].replace(
            replacement.match,
            `%recipient.${replacement.id}%`
        );
    });

    const emails = [];
    const emailData = {};
    memberRows.forEach((memberRow) => {
        emails.push(memberRow.email);

        // first_name is a computed property only used here for now
        // TODO: move into model computed property or output serializer?
        memberRow.first_name = (memberRow.name || '').split(' ')[0];

        // add static data to mailgun template variables
        const data = {
            unique_id: memberRow.uuid,
            unsubscribe_url: postEmailSerializer.createUnsubscribeUrl(memberRow.uuid)
        };

        // add replacement data/requested fallback to mailgun template variables
        replacements.forEach(({id, memberProp, fallback}) => {
            data[id] = memberRow[memberProp] || fallback || '';
        });

        emailData[memberRow.email] = data;
    });

    debug(`getEmailData: done (${Date.now() - startTime}ms)`);
    return {emailTmpl, emails, emailData};
};

const sendEmail = async (postModel, memberRows) => {
    const {emailTmpl, emails, emailData} = await getEmailData(postModel, memberRows);

    return bulkEmailService.send(emailTmpl, emails, emailData);
};

const sendTestEmail = async (postModel, toEmails) => {
    const recipients = await Promise.all(toEmails.map(async (email) => {
        const member = await membersService.api.members.get({email});
        return member || new models.Member({email});
    }));
    const {emailTmpl, emails, emailData} = await getEmailData(postModel, recipients);
    emailTmpl.subject = `[Test] ${emailTmpl.subject}`;
    return bulkEmailService.send(emailTmpl, emails, emailData);
};

/**
 * addEmail
 *
 * Accepts a post model and creates an email record based on it. Only creates one
 * record per post
 *
 * @param {object} postModel Post Model Object
 */

const addEmail = async (postModel, options) => {
    const knexOptions = _.pick(options, ['transacting', 'forUpdate']);
    const filterOptions = Object.assign({}, knexOptions, {filter: 'subscribed:true', limit: 1});

    if (postModel.get('visibility') === 'paid') {
        filterOptions.paid = true;
    }

    const startRetrieve = Date.now();
    debug('addEmail: retrieving members count');
    const {meta: {pagination: {total: membersCount}}} = await membersService.api.members.list(Object.assign({}, knexOptions, filterOptions));
    debug(`addEmail: retrieved members count - ${membersCount} members (${Date.now() - startRetrieve}ms)`);

    // NOTE: don't create email object when there's nobody to send the email to
    if (membersCount === 0) {
        return null;
    }

    const postId = postModel.get('id');
    const existing = await models.Email.findOne({post_id: postId}, knexOptions);

    if (!existing) {
        // get email contents and perform replacements using no member data so
        // we have a decent snapshot of email content for later display
        const {emailTmpl, replacements} = await postEmailSerializer.serialize(postModel, {isBrowserPreview: true});
        replacements.forEach((replacement) => {
            emailTmpl[replacement.format] = emailTmpl[replacement.format].replace(
                replacement.match,
                replacement.fallback || ''
            );
        });

        return models.Email.add({
            post_id: postId,
            status: 'pending',
            email_count: membersCount,
            subject: emailTmpl.subject,
            html: emailTmpl.html,
            plaintext: emailTmpl.plaintext,
            submitted_at: moment().toDate()
        }, knexOptions);
    } else {
        return existing;
    }
};

/**
 * retryFailedEmail
 *
 * Accepts an Email model and resets it's fields to trigger retry listeners
 *
 * @param {object} model Email model
 */
const retryFailedEmail = async (model) => {
    return await models.Email.edit({
        status: 'pending'
    }, {
        id: model.get('id')
    });
};

/**
 * handleUnsubscribeRequest
 *
 * Takes a request/response pair and reads the `unsubscribe` query parameter,
 * using the content to update the members service to set the `subscribed` flag
 * to false on the member
 *
 * If any operation fails, or the request is invalid the function will error - so using
 * as middleware should consider wrapping with `try/catch`
 *
 * @param {Request} req
 * @returns {Promise<void>}
 */
async function handleUnsubscribeRequest(req) {
    if (!req.url) {
        throw new errors.BadRequestError({
            message: 'Unsubscribe failed! Could not find member'
        });
    }

    const {query} = url.parse(req.url, true);
    if (!query || !query.uuid) {
        throw new errors.BadRequestError({
            message: (query.preview ? 'Unsubscribe preview' : 'Unsubscribe failed! Could not find member')
        });
    }

    const member = await membersService.api.members.get({
        uuid: query.uuid
    });

    if (!member) {
        throw new errors.BadRequestError({
            message: 'Unsubscribe failed! Could not find member'
        });
    }

    try {
        const memberModel = await membersService.api.members.update({subscribed: false}, {id: member.id});
        return memberModel.toJSON();
    } catch (err) {
        throw new errors.InternalServerError({
            message: 'Failed to unsubscribe member'
        });
    }
}

async function sendEmailJob({emailModel, options}) {
    const postModel = await models.Post.findOne({id: emailModel.get('post_id')}, {withRelated: ['authors']});
    let meta = [];
    let error = null;
    let startEmailSend = null;

    try {
        // Check host limit for allowed member count and throw error if over limit
        await membersService.checkHostLimit();

        const knexOptions = _.pick(options, ['transacting', 'forUpdate']);
        // TODO: this will clobber a user-assigned filter if/when we allow emails to be sent to filtered member lists
        const filterOptions = Object.assign({}, knexOptions, {filter: 'subscribed:true'});

        if (postModel.get('visibility') === 'paid') {
            filterOptions.paid = true;
        }

        const startRetrieve = Date.now();
        debug('pendingEmailHandler: retrieving members list');
        const memberQuery = await models.Member.getFilteredCollection(filterOptions).query();
        // TODO: how to apply this more elegantly? Normally done by `onFetching` bookshelf hook
        if (options.transacting) {
            memberQuery.transacting(options.transacting);
            if (options.forUpdate) {
                memberQuery.forUpdate();
            }
        }
        const memberRows = await memberQuery;
        debug(`pendingEmailHandler: retrieved members list - ${memberRows.length} members (${Date.now() - startRetrieve}ms)`);

        if (!memberRows.length) {
            return;
        }

        await models.Email.edit({
            status: 'submitting'
        }, {
            id: emailModel.id
        });

        debug('pendingEmailHandler: storing recipient list');
        const startOfRecipientStorage = Date.now();
        const storeRecipientBatch = async function (recipients) {
            let batchModel = await models.EmailBatch.add({email_id: emailModel.id}, knexOptions);

            // use knex rather than bookshelf to avoid overhead and event loop blocking
            // when instantiating large numbers of bookshelf model objects
            const recipientData = recipients.map((memberRow) => {
                return {
                    id: ObjectId.generate(),
                    email_id: emailModel.id,
                    member_id: memberRow.id,
                    batch_id: batchModel.id,
                    member_uuid: memberRow.uuid,
                    member_email: memberRow.email,
                    member_name: memberRow.name
                };
            });
            return await db.knex('email_recipients').insert(recipientData);
        };
        await Promise.each(_.chunk(memberRows, 1000), storeRecipientBatch);
        debug(`pendingEmailHandler: stored recipient list (${Date.now() - startOfRecipientStorage}ms)`);

        // NOTE: meta contains an array which can be a mix of successful and error responses
        //       needs filtering and saving objects of {error, batchData} form to separate property
        debug('pendingEmailHandler: sending email');
        startEmailSend = Date.now();
        meta = await sendEmail(postModel, memberRows);
        debug(`pendingEmailHandler: sent email (${Date.now() - startEmailSend}ms)`);
    } catch (err) {
        if (startEmailSend) {
            debug(`pendingEmailHandler: send email failed (${Date.now() - startEmailSend}ms)`);
        }
        logging.error(new errors.GhostError({
            err: err,
            context: i18n.t('errors.services.mega.requestFailed.error')
        }));
        error = err.message;
    }

    const successes = meta.filter(response => (response instanceof bulkEmailService.SuccessfulBatch));
    const failures = meta.filter(response => (response instanceof bulkEmailService.FailedBatch));
    const batchStatus = successes.length ? 'submitted' : 'failed';

    if (!error && failures.length) {
        error = failures[0].error.message;
    }

    if (error && error.length > 2000) {
        error = error.substring(0, 2000);
    }

    try {
        // CASE: the batch partially succeeded
        await models.Email.edit({
            status: batchStatus,
            meta: JSON.stringify(successes),
            error: error,
            error_data: JSON.stringify(failures) // NOTE: need to discuss how we store this
        }, {
            id: emailModel.id
        });
    } catch (err) {
        logging.error(err);
    }
}

async function pendingEmailHandler(emailModel, options) {
    // CASE: do not send email if we import a database
    // TODO: refactor post.published events to never fire on importing
    if (options && options.importing) {
        return;
    }

    if (emailModel.get('status') !== 'pending') {
        return;
    }

    return jobService.addJob(sendEmailJob, {emailModel, options});
}

const statusChangedHandler = (emailModel, options) => {
    const emailRetried = emailModel.wasChanged()
        && emailModel.get('status') === 'pending'
        && emailModel.previous('status') === 'failed';

    if (emailRetried) {
        pendingEmailHandler(emailModel, options);
    }
};

function listen() {
    events.on('email.added', pendingEmailHandler);
    events.on('email.edited', statusChangedHandler);
}

// Public API
module.exports = {
    listen,
    addEmail,
    retryFailedEmail,
    sendTestEmail,
    handleUnsubscribeRequest
};
