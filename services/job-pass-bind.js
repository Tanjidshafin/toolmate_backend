/**
 * Shared, provider-agnostic Job Pass binding logic.
 *
 * Both the Stripe webhook handler and the PayPal capture endpoint /
 * webhook handler funnel through `bindPassToJob`. The function is
 * idempotent on (paymentProvider, providerPaymentId) and will:
 *
 *   1. Upsert a JobPasses row for this purchase (status=active or consumed).
 *   2. If a jobId was provided at checkout, atomically:
 *        - decrement packRemaining,
 *        - mark the pass as consumed (single) or append to consumptions[],
 *        - flip the matching SavedJob to lockState=unlocked.
 *
 * If no jobId was supplied (e.g. user bought a 3-pack in advance), the
 * pass stays "active" with `packRemaining > 0` and gets consumed later
 * by `POST /jobs/:jobId/unlock`.
 *
 * Race / replay safety:
 * - Pass-level idempotency: composite unique index on
 *   (paymentProvider, providerPaymentId) in MongoDB rejects double-inserts.
 * - Job-level idempotency: `consumePassForJob` uses a conditional update
 *   that only succeeds when the pass still has remaining quantity.
 * - When transactions are available we wrap pass-insert + job-unlock
 *   together; otherwise we fall back to best-effort sequential writes
 *   that are still idempotent because of the indexes above.
 */

const { randomUUID } = require('crypto');

const supportsTransactions = (mongoClient) => {
  return Boolean(
    mongoClient && typeof mongoClient.startSession === 'function' && process.env.MONGO_TRANSACTIONS !== 'false',
  );
};

const buildSessionOptions = (session) => (session ? { session } : undefined);
const TERMINAL_PASS_STATUSES = new Set(['consumed', 'refunded', 'revoked']);

/**
 * MongoDB Node.js driver v6+ returns the document directly from findOneAndUpdate
 * (when includeResultMetadata is false). Older code expected `result.value`.
 */
const findOneAndUpdateDoc = (result) => {
  if (result == null) return null;
  const v = result.value;
  if (v !== undefined) return v;
  return result;
};

const upsertPassRow = async ({
  jobPassesStorage,
  parsedEvent,
  passId,
  status,
  rawEvent,
  session,
}) => {
  const now = new Date();
  const sessionOptions = buildSessionOptions(session);
  const paymentFilter = {
    paymentProvider: parsedEvent.paymentProvider,
    providerPaymentId: parsedEvent.providerPaymentId,
  };

  let existing = (await jobPassesStorage.findOne(paymentFilter, sessionOptions)) || null;

  if (!existing && (passId || parsedEvent.passId)) {
    existing =
      (await jobPassesStorage.findOne(
        { passId: passId || parsedEvent.passId },
        sessionOptions,
      )) || null;
  }

  if (!existing && parsedEvent.providerOrderId) {
    existing =
      (await jobPassesStorage.findOne(
        {
          paymentProvider: parsedEvent.paymentProvider,
          providerOrderId: parsedEvent.providerOrderId,
        },
        sessionOptions,
      )) || null;
  }

  const purchasedAt = existing?.purchasedAt || now;
  const providerRawEvent = rawEvent ? truncateRawEvent(rawEvent) : existing?.providerRawEvent || null;
  const nextStatus = TERMINAL_PASS_STATUSES.has(existing?.status) ? existing.status : status;

  const setOnInsert = {
    passId: passId || parsedEvent.passId || randomUUID(),
    paymentProvider: parsedEvent.paymentProvider,
    packRemaining: parsedEvent.packQuantity || 1,
    consumptions: [],
    consumedAt: null,
    consumedByJobId: null,
    refundedAt: null,
    revokedAt: null,
    createdAt: now,
  };

  const setUpdate = {
    status: nextStatus,
    updatedAt: now,
    providerRawEvent,
    providerOrderId: parsedEvent.providerOrderId,
    providerPaymentId: parsedEvent.providerPaymentId,
    providerPayerId: parsedEvent.providerPayerId || null,
    providerPriceRef: parsedEvent.providerPriceRef || null,
    productSku: parsedEvent.productSku,
    packQuantity: parsedEvent.packQuantity || 1,
    priceVariant: parsedEvent.priceVariant || 'standard',
    amountPaid: parsedEvent.amountPaid || null,
    currency: parsedEvent.currency || 'AUD',
    purchasedAt,
  };
  if (parsedEvent.userId) setUpdate.userId = parsedEvent.userId;
  if (parsedEvent.userEmail) setUpdate.userEmail = parsedEvent.userEmail;

  const opts = session ? { session, returnDocument: 'after' } : { returnDocument: 'after' };

  const result = await jobPassesStorage.findOneAndUpdate(
    existing ? { _id: existing._id } : paymentFilter,
    {
      $setOnInsert: setOnInsert,
      $set: setUpdate,
    },
    { ...opts, upsert: true },
  );

  return (
    findOneAndUpdateDoc(result) || (await jobPassesStorage.findOne(existing ? { _id: existing._id } : paymentFilter, opts))
  );
};

const truncateRawEvent = (raw) => {
  try {
    const json = JSON.stringify(raw);
    if (json.length <= 8192) return raw;
    return { truncated: true, preview: json.slice(0, 8000) };
  } catch {
    return { truncated: true, error: 'unserializable' };
  }
};

/**
 * Conditionally consume one unit of a pass for a specific saved job. Returns
 * the updated pass document, or null if the pass had no remaining quantity
 * or was already consumed by another job.
 *
 * The conditional `packRemaining > 0` filter is what protects against the
 * "two browser tabs both clicked Use my pass" race.
 */
const consumePassForJob = async ({
  jobPassesStorage,
  passId,
  jobId,
  session,
}) => {
  if (!passId || !jobId) return null;
  const now = new Date();
  const opts = session ? { session, returnDocument: 'after' } : { returnDocument: 'after' };

  const result = await jobPassesStorage.findOneAndUpdate(
    {
      passId,
      packRemaining: { $gt: 0 },
      status: { $in: ['active', 'pending'] },
    },
    {
      $inc: { packRemaining: -1 },
      $push: { consumptions: { jobId, consumedAt: now } },
      $set: {
        updatedAt: now,
      },
    },
    opts,
  );

  const updated = findOneAndUpdateDoc(result);
  if (!updated) return null;

  // If we just consumed the LAST seat in the pack flip status to consumed.
  const next = updated;
  if (next.packRemaining <= 0 && next.status !== 'consumed') {
    const finalize = await jobPassesStorage.findOneAndUpdate(
      { passId, status: { $ne: 'consumed' } },
      {
        $set: {
          status: 'consumed',
          consumedAt: now,
          consumedByJobId: jobId,
          updatedAt: now,
        },
      },
      opts,
    );
    return findOneAndUpdateDoc(finalize) || next;
  }
  return next;
};

const unlockSavedJob = async ({
  savedJobsStorage,
  jobId,
  passId,
  paymentProvider,
  paymentId,
  session,
}) => {
  if (!jobId) return null;
  const now = new Date();
  const opts = session ? { session, returnDocument: 'after' } : { returnDocument: 'after' };
  const result = await savedJobsStorage.findOneAndUpdate(
    { jobId },
    {
      $set: {
        lockState: 'unlocked',
        unlockType: 'job_pass',
        passId,
        paymentId,
        paymentProvider,
        unlockedAt: now,
        updatedAt: now,
      },
    },
    opts,
  );
  return findOneAndUpdateDoc(result);
};

/**
 * Main entrypoint. Both webhooks and the PayPal in-page capture call this.
 *
 * @returns {Promise<{ pass, savedJob, alreadyBound, status }>}
 */
const bindPassToJob = async ({
  mongoClient,
  jobPassesStorage,
  savedJobsStorage,
  subscriptionStorage,
  offerAnalyticsStorage,
  auditLogger,
  parsedEvent,
  rawEvent,
}) => {
  if (!parsedEvent?.providerPaymentId) {
    throw new Error('bindPassToJob requires parsedEvent.providerPaymentId for idempotency');
  }
  const passId = parsedEvent.passId || randomUUID();
  const targetJobId = parsedEvent.jobId || null;

  const runner = async (session) => {
    // Insert/upsert the pass first, with status=active so a future job-unlock
    // call (or an admin override) can consume it.
    let pass = await upsertPassRow({
      jobPassesStorage,
      parsedEvent,
      passId,
      status: 'active',
      rawEvent,
      session,
    });

    // If the buyer specified a jobId at checkout time, immediately consume
    // one seat of the pass for that job and unlock it.
    if (targetJobId) {
      const beforeRemaining = pass.packRemaining;
      const consumed = await consumePassForJob({
        jobPassesStorage,
        passId: pass.passId,
        jobId: targetJobId,
        session,
      });
      if (consumed) {
        pass = consumed;
        const savedJob = await unlockSavedJob({
          savedJobsStorage,
          jobId: targetJobId,
          passId: pass.passId,
          paymentProvider: parsedEvent.paymentProvider,
          paymentId: parsedEvent.providerPaymentId,
          session,
        });
        return { pass, savedJob, alreadyBound: false, status: 'unlocked', beforeRemaining };
      }
      // Pass already had no remaining seats — likely a webhook replay after the
      // SDK in-page capture already bound it. That's fine.
      return { pass, savedJob: null, alreadyBound: true, status: 'already_bound' };
    }

    return { pass, savedJob: null, alreadyBound: false, status: 'unbound' };
  };

  let result;
  if (supportsTransactions(mongoClient)) {
    const session = mongoClient.startSession();
    try {
      await session.withTransaction(async () => {
        result = await runner(session);
      });
    } finally {
      await session.endSession();
    }
  } else {
    result = await runner(null);
  }

  // Post-binding analytics + audit. Soft-fail so a failed analytics insert
  // never breaks payment.
  try {
    if (subscriptionStorage && parsedEvent.userEmail) {
      const purchaseDisplay =
        parsedEvent.productSku === 'job_pass_3pack' ? '3 Job Pass Pack' : 'Single Job Pass';
      const purchaseLogKey = `job_pass_purchase:${parsedEvent.paymentProvider}:${parsedEvent.providerPaymentId}`;
      const existingPurchaseLog = await subscriptionStorage.findOne({
        userEmail: parsedEvent.userEmail,
        'metadata.idempotencyKey': purchaseLogKey,
      });
      if (!existingPurchaseLog) {
        const normalizedAmount =
          typeof parsedEvent.amountPaid === 'number' ? Number((parsedEvent.amountPaid / 100).toFixed(2)) : 0;
        await subscriptionStorage.insertOne({
          userEmail: parsedEvent.userEmail,
          userId: parsedEvent.userId || parsedEvent.userEmail,
          clerkId: parsedEvent.userId || null,
          userName: parsedEvent.userEmail,
          type: 'job_pass_purchase',
          description: `${purchaseDisplay} purchase completed`,
          amount: normalizedAmount,
          currency: (parsedEvent.currency || 'AUD').toUpperCase(),
          status: 'completed',
          date: new Date(),
          createdAt: new Date(),
          metadata: {
            idempotencyKey: purchaseLogKey,
            kind: 'job_pass',
            paymentProvider: parsedEvent.paymentProvider,
            providerOrderId: parsedEvent.providerOrderId || null,
            providerPaymentId: parsedEvent.providerPaymentId,
            providerPriceRef: parsedEvent.providerPriceRef || null,
            productSku: parsedEvent.productSku || 'job_pass_single',
            packQuantity: parsedEvent.packQuantity || 1,
            packRemaining: result.pass?.packRemaining ?? null,
            passId: result.pass?.passId || passId,
            jobId: targetJobId,
            status: result.status,
          },
        });
      }
    }

    if (offerAnalyticsStorage) {
      await offerAnalyticsStorage.insertOne({
        eventName:
          result.status === 'unlocked'
            ? 'job_pass_checkout_completed'
            : 'job_pass_checkout_completed_unbound',
        userId: parsedEvent.userId || null,
        userEmail: parsedEvent.userEmail || null,
        jobId: targetJobId,
        passId: result.pass?.passId || passId,
        paymentProvider: parsedEvent.paymentProvider,
        providerOrderId: parsedEvent.providerOrderId,
        providerPaymentId: parsedEvent.providerPaymentId,
        providerPriceRef: parsedEvent.providerPriceRef,
        variant: parsedEvent.priceVariant || 'standard',
        amount: parsedEvent.amountPaid,
        currency: parsedEvent.currency,
        productSku: parsedEvent.productSku,
        packQuantity: parsedEvent.packQuantity,
        triggerReason: 'webhook_or_capture',
        triggerType: 'system',
        createdAt: new Date(),
      });
    }
  } catch (err) {
    console.warn('bindPassToJob: analytics insert failed:', err?.message || err);
  }

  try {
    if (auditLogger) {
      await auditLogger.logAudit({
        action: result.status === 'unlocked' ? 'JOB_PASS_BOUND' : 'JOB_PASS_PURCHASED',
        resource: 'job_pass',
        resourceId: result.pass?.passId || passId,
        userId: parsedEvent.userId || 'system',
        userEmail: parsedEvent.userEmail || 'system@toolmate.com',
        role: 'system',
        newData: {
          jobId: targetJobId,
          paymentProvider: parsedEvent.paymentProvider,
          providerOrderId: parsedEvent.providerOrderId,
          providerPaymentId: parsedEvent.providerPaymentId,
          variant: parsedEvent.priceVariant,
          amountPaid: parsedEvent.amountPaid,
          currency: parsedEvent.currency,
          status: result.status,
          alreadyBound: result.alreadyBound,
        },
      });
    }
  } catch (err) {
    console.warn('bindPassToJob: audit log failed:', err?.message || err);
  }

  return result;
};

module.exports = {
  bindPassToJob,
  consumePassForJob,
  unlockSavedJob,
};
