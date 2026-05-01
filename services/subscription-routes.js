const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { format, differenceInMonths, startOfMonth, endOfMonth, addMonths, differenceInDays } = require('date-fns');

const SUBSCRIPTION_GRACE_DAYS = Number.parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);
const ONE_TIME_SUBSCRIPTION_DAYS = Number.parseInt(process.env.ONE_TIME_SUBSCRIPTION_DAYS || '30', 10);

const {
  ACTIVE_STATUSES,
  parseSubscriptionFields,
  isSubscriptionEntitled,
  normalizeSubscription,
  prepareSubscriptionForStore,
  buildSubscriptionViewFromCore,
  getUserProStatus,
} = require('./subscription-status');
const stripeProvider = require('./payment-providers/stripe-provider');
const { bindPassToJob } = require('./job-pass-bind');

const isUserPro = getUserProStatus;

const getBillingPriceId = () => {
  return process.env.STRIPE_PRICE_ID_BEST_MATES_RECURRING || process.env.STRIPE_PRICE_ID_BEST_MATES || null;
};

const getSafeOrigin = (req) => {
  const rawOrigin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
  return rawOrigin.endsWith('/') ? rawOrigin.slice(0, -1) : rawOrigin;
};

const calculateOneTimePeriodEnd = (startDate) => {
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + ONE_TIME_SUBSCRIPTION_DAYS);
  return endDate;
};

module.exports = (dependencies) => {
  const {
    usersStorage,
    auditLogger,
    clerkClient,
    ObjectId,
    getUserInfoFromRequest,
    sessionsStorage,
    messagesStorage,
    mateyChatSessionsStorage,
    messagesJobStorage,
    shedToolsStorage,
    subscriptionStorage,
    mongoClient,
    jobPassesStorage,
    savedJobsStorage,
    offerAnalyticsStorage,
  } = dependencies;

  const router = express.Router();

  const getUserIdentityFilters = (userEmail, clerkId = null) => {
    const normalizedEmail = userEmail ? String(userEmail).toLowerCase() : null;
    const userEmailCandidates = [userEmail, normalizedEmail].filter(Boolean);
    const userIdCandidates = [clerkId, userEmail, normalizedEmail].filter(Boolean);

    return {
      sessionFilter: {
        $or: [
          { userEmail: { $in: userEmailCandidates } },
          { userId: { $in: userIdCandidates } },
        ],
      },
      messageFilter: {
        $or: [
          { userEmail: { $in: userEmailCandidates } },
          { userId: { $in: userIdCandidates } },
        ],
      },
      savedJobFilter: {
        deletedAt: { $in: [null, undefined] },
        $or: [
          { userEmail: { $in: userEmailCandidates } },
          { userId: { $in: userIdCandidates } },
        ],
      },
      shedFilter: {
        collection: { $ne: 'shed_analytics' },
        user_id: { $in: userIdCandidates },
      },
    };
  };

  const formatPurchaseDisplay = (metadata = {}) => {
    const isJobPass = metadata.kind === 'job_pass' || Boolean(metadata.productSku);
    const productSku = metadata.productSku || null;
    const packQuantity = Number(metadata.packQuantity || 0) || (productSku === 'job_pass_3pack' ? 3 : 1);
    const displayName = isJobPass
      ? productSku === 'job_pass_3pack'
        ? '3 Job Pass Pack'
        : 'Single Job Pass'
      : metadata.plan || 'Best Mates';

    return {
      purchaseKind: isJobPass ? 'job_pass' : 'subscription',
      displayName,
      packQuantity: isJobPass ? packQuantity : null,
    };
  };

  const calculateUsageMetrics = async ({ userEmail, clerkId }) => {
    const filters = getUserIdentityFilters(userEmail, clerkId);
    const [totalJobSession, totalMessages, totalSavedJob, totalSheds, suggestedToolsAgg, lastSession] = await Promise.all([
      mateyChatSessionsStorage
        ? mateyChatSessionsStorage.countDocuments({
            ...filters.sessionFilter,
            messageCount: { $gt: 0 },
          })
        : 0,
      messagesJobStorage ? messagesJobStorage.countDocuments(filters.messageFilter) : 0,
      savedJobsStorage ? savedJobsStorage.countDocuments(filters.savedJobFilter) : 0,
      shedToolsStorage ? shedToolsStorage.countDocuments(filters.shedFilter) : 0,
      mateyChatSessionsStorage
        ? mateyChatSessionsStorage
            .aggregate([
              { $match: filters.sessionFilter },
              { $group: { _id: null, totalSuggestedTools: { $sum: { $ifNull: ['$totalSuggestedTools', 0] } } } },
            ])
            .toArray()
        : [],
      mateyChatSessionsStorage
        ? mateyChatSessionsStorage.findOne(filters.sessionFilter, { sort: { lastMessageAt: -1, updatedAt: -1, createdAt: -1 } })
        : null,
    ]);

    return {
      totalJobSession,
      totalSavedJob,
      totalMessages,
      totalSheds,
      totalSuggestedTools: suggestedToolsAgg?.[0]?.totalSuggestedTools || 0,
      lastActivity: lastSession?.lastMessageAt || lastSession?.updatedAt || lastSession?.createdAt || null,
    };
  };

  const upsertSubscriptionState = async (userEmail, nextSubscription) => {
    const now = new Date();
    const toStore = prepareSubscriptionForStore(nextSubscription, now);
    const entitled = isSubscriptionEntitled(toStore, now);

    await usersStorage.updateOne(
      { userEmail },
      {
        $set: {
          subscription: {
            ...toStore,
            updatedAt: now,
          },
          isSubscribed: entitled,
          updatedAt: now,
        },
      }
    );
  };

  const insertLogIfMissing = async ({ dedupeQuery, logEntry }) => {
    const existingLog = await subscriptionStorage.findOne(dedupeQuery);
    if (existingLog) {
      return existingLog;
    }

    const result = await subscriptionStorage.insertOne(logEntry);
    return {
      ...logEntry,
      _id: result.insertedId,
    };
  };

  const upsertCheckoutSuccessLog = async (user, checkoutSession, source = 'stripe_system') => {
    await insertLogIfMissing({
      dedupeQuery: {
        userEmail: user.userEmail,
        'metadata.stripeSessionId': checkoutSession.id,
        status: 'completed',
        type: 'purchase',
      },
      logEntry: {
      userEmail: user.userEmail,
      userId: user.clerkId || user.userEmail,
      clerkId: user.clerkId,
      userName: user.userName,
      type: 'purchase',
      description: `${checkoutSession.metadata?.plan || 'Best Mates'} Subscription`,
      amount: typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total / 100 : 0,
      currency: (checkoutSession.currency || 'AUD').toUpperCase(),
      status: 'completed',
      date: new Date(),
      createdAt: new Date(),
      metadata: {
        stripeSessionId: checkoutSession.id,
        stripeCustomerId: checkoutSession.customer || null,
        stripeSubscriptionId:
          typeof checkoutSession.subscription === 'string' ? checkoutSession.subscription : checkoutSession.subscription?.id,
        plan: checkoutSession.metadata?.plan || 'Best Mates',
        billingMode: checkoutSession.metadata?.billingMode || 'auto_renew',
        source,
      },
      },
    });
  };

  const upsertCheckoutCancelLog = async (userEmail, checkoutSession, source = 'checkout_cancel', reason = null) => {
    const user = await usersStorage.findOne({ userEmail });
    if (!user) return;

    await insertLogIfMissing({
      dedupeQuery: {
        userEmail,
        'metadata.stripeSessionId': checkoutSession.id,
        status: 'checkout_cancel',
      },
      logEntry: {
        userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: 'checkout_cancel',
        description: 'Checkout cancelled before payment completion',
        amount: typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total / 100 : 0,
        currency: (checkoutSession.currency || 'AUD').toUpperCase(),
        status: 'checkout_cancel',
        date: new Date(),
        createdAt: new Date(),
        reason: reason || 'Checkout was cancelled',
        metadata: {
          stripeSessionId: checkoutSession.id,
          stripeStatus: checkoutSession.status,
          paymentStatus: checkoutSession.payment_status,
          plan: checkoutSession.metadata?.plan || 'Best Mates',
          billingMode: checkoutSession.metadata?.billingMode || 'auto_renew',
          source,
        },
      },
    });
  };

  const syncCheckoutSessionToUser = async (checkoutSession, source = 'session_verify') => {
    const userEmail = checkoutSession.metadata?.userEmail || checkoutSession.customer_details?.email || checkoutSession.customer_email;
    if (!userEmail) {
      return { paid: false, error: 'Unable to resolve user from checkout session' };
    }

    const user = await usersStorage.findOne({ userEmail });
    if (!user) {
      return { paid: false, error: 'User not found for checkout session' };
    }

    const paid = checkoutSession.payment_status === 'paid';
    if (!paid) {
      return {
        paid: false,
        userEmail,
        status: checkoutSession.status,
        paymentStatus: checkoutSession.payment_status,
      };
    }

    const nextSubscription = parseSubscriptionFields(user);
    const now = new Date();
    const isLegacyOneTimeCheckout =
      checkoutSession.mode === 'payment' || checkoutSession.metadata?.billingMode === 'one_time';

    if (isLegacyOneTimeCheckout) {
      nextSubscription.status = 'active';
      nextSubscription.plan = 'premium';
      nextSubscription.billingMode = 'one_time';
      nextSubscription.stripeCustomerId = typeof checkoutSession.customer === 'string' ? checkoutSession.customer : null;
      nextSubscription.stripeSubscriptionId = null;
      nextSubscription.currentPeriodStart = now;
      nextSubscription.currentPeriodEnd = calculateOneTimePeriodEnd(now);
      nextSubscription.cancelAtPeriodEnd = true;
      nextSubscription.gracePeriodEndsAt = null;

      await upsertSubscriptionState(userEmail, nextSubscription);
      await upsertCheckoutSuccessLog(user, checkoutSession, source);

      return {
        paid: true,
        userEmail,
        subscription: nextSubscription,
        amount: typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total / 100 : 0,
        currency: (checkoutSession.currency || 'AUD').toUpperCase(),
        plan: checkoutSession.metadata?.plan || 'Best Mates',
      };
    }

    const stripeSubscriptionId =
      typeof checkoutSession.subscription === 'string'
        ? checkoutSession.subscription
        : checkoutSession.subscription?.id || null;

    let stripeSubscription = null;
    if (stripeSubscriptionId) {
      stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    }

    nextSubscription.status = stripeSubscription?.status || 'active';
    nextSubscription.billingMode = 'auto_renew';
    nextSubscription.stripeCustomerId =
      (stripeSubscription?.customer && typeof stripeSubscription.customer === 'string'
        ? stripeSubscription.customer
        : typeof checkoutSession.customer === 'string'
        ? checkoutSession.customer
        : null) || null;
    nextSubscription.stripeSubscriptionId = stripeSubscriptionId;
    nextSubscription.currentPeriodStart = stripeSubscription?.current_period_start
      ? new Date(stripeSubscription.current_period_start * 1000)
      : now;
    nextSubscription.currentPeriodEnd = stripeSubscription?.current_period_end
      ? new Date(stripeSubscription.current_period_end * 1000)
      : null;
    nextSubscription.cancelAtPeriodEnd = Boolean(stripeSubscription?.cancel_at_period_end);
    nextSubscription.gracePeriodEndsAt =
      nextSubscription.status === 'past_due'
        ? new Date(Date.now() + SUBSCRIPTION_GRACE_DAYS * 24 * 60 * 60 * 1000)
        : null;

    await upsertSubscriptionState(userEmail, nextSubscription);
    await upsertCheckoutSuccessLog(user, checkoutSession, source);

    return {
      paid: true,
      userEmail,
      subscription: nextSubscription,
      amount: typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total / 100 : 0,
      currency: (checkoutSession.currency || 'AUD').toUpperCase(),
      plan: checkoutSession.metadata?.plan || 'Best Mates',
    };
  };

  const syncStripeSubscriptionToUser = async (stripeSubscription, source = 'webhook_sync', eventId = null) => {
    const customerId =
      stripeSubscription.customer && typeof stripeSubscription.customer === 'string' ? stripeSubscription.customer : null;

    const user = await usersStorage.findOne({
      $or: [
        { 'subscription.stripeSubscriptionId': stripeSubscription.id },
        ...(customerId ? [{ 'subscription.stripeCustomerId': customerId }] : []),
      ],
    });

    if (!user) return false;

    const nextSubscription = parseSubscriptionFields(user);
    const prevCore = { ...nextSubscription };
    nextSubscription.status = stripeSubscription.status || 'inactive';
    nextSubscription.billingMode = 'auto_renew';
    nextSubscription.stripeCustomerId = customerId;
    nextSubscription.stripeSubscriptionId = stripeSubscription.id;
    nextSubscription.currentPeriodStart = stripeSubscription.current_period_start
      ? new Date(stripeSubscription.current_period_start * 1000)
      : nextSubscription.currentPeriodStart;
    nextSubscription.currentPeriodEnd = stripeSubscription.current_period_end
      ? new Date(stripeSubscription.current_period_end * 1000)
      : nextSubscription.currentPeriodEnd;
    nextSubscription.cancelAtPeriodEnd = Boolean(stripeSubscription.cancel_at_period_end);
    if (nextSubscription.status === 'past_due') {
      if (prevCore.status === 'past_due' && prevCore.gracePeriodEndsAt) {
        nextSubscription.gracePeriodEndsAt = new Date(prevCore.gracePeriodEndsAt);
      } else {
        nextSubscription.gracePeriodEndsAt = new Date(Date.now() + SUBSCRIPTION_GRACE_DAYS * 24 * 60 * 60 * 1000);
      }
    } else {
      nextSubscription.gracePeriodEndsAt = null;
    }

    await upsertSubscriptionState(user.userEmail, nextSubscription);

    const isSubscriptionCancel = stripeSubscription.status === 'canceled';
    const logType = isSubscriptionCancel ? 'cancellation' : 'subscription_sync';
    const logStatus = isSubscriptionCancel ? 'subscription_cancel' : 'completed';

    const dedupeQuery = eventId
      ? {
          userEmail: user.userEmail,
          'metadata.stripeEventId': eventId,
        }
      : {
          userEmail: user.userEmail,
          'metadata.source': source,
          'metadata.stripeSubscriptionId': stripeSubscription.id,
          'metadata.stripeStatus': stripeSubscription.status,
        };

    await insertLogIfMissing({
      dedupeQuery,
      logEntry: {
      userEmail: user.userEmail,
      userId: user.clerkId || user.userEmail,
      clerkId: user.clerkId,
      userName: user.userName,
      type: logType,
      description: isSubscriptionCancel
        ? 'Subscription cancelled via Stripe lifecycle'
        : `Stripe subscription ${nextSubscription.status}`,
      amount: 0,
      currency: 'AUD',
      status: logStatus,
      date: new Date(),
      createdAt: new Date(),
      metadata: {
        source,
        stripeEventId: eventId,
        stripeSubscriptionId: stripeSubscription.id,
        stripeCustomerId: customerId,
        stripeStatus: stripeSubscription.status,
      },
      },
    });

    return true;
  };

  const getDateFilters = (period, startDate, endDate) => {
    let dateFilter = {};
    let previousPeriodFilter = {};
    const now = new Date();

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      // Validate dates
      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error('Invalid date range provided');
      }

      dateFilter = { createdAt: { $gte: start, $lte: end } };
      const diffTime = Math.abs(end.getTime() - start.getTime());
      const prevStart = new Date(start.getTime() - diffTime - 24 * 60 * 60 * 1000);
      const prevEnd = new Date(start.getTime() - 24 * 60 * 60 * 1000);
      previousPeriodFilter = { createdAt: { $gte: prevStart, $lte: prevEnd } };
    } else {
      // Ensure we're working with a valid date
      const currentTime = now.getTime();

      switch (period) {
        case '24h':
        case 'hourly':
          const hours24Ago = new Date(currentTime - 24 * 60 * 60 * 1000);
          dateFilter = { createdAt: { $gte: hours24Ago } };
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(currentTime - 48 * 60 * 60 * 1000),
              $lt: hours24Ago,
            },
          };
          break;
        case '7d':
        case 'daily':
          const days7Ago = new Date(currentTime - 7 * 24 * 60 * 60 * 1000);
          dateFilter = { createdAt: { $gte: days7Ago } };
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(currentTime - 14 * 24 * 60 * 60 * 1000),
              $lt: days7Ago,
            },
          };
          break;
        case '30d':
        case 'monthly':
          const days30Ago = new Date(currentTime - 30 * 24 * 60 * 60 * 1000);
          dateFilter = { createdAt: { $gte: days30Ago } };
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(currentTime - 60 * 24 * 60 * 60 * 1000),
              $lt: days30Ago,
            },
          };
          break;
        case '90d':
          const days90Ago = new Date(currentTime - 90 * 24 * 60 * 60 * 1000);
          dateFilter = { createdAt: { $gte: days90Ago } };
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(currentTime - 180 * 24 * 60 * 60 * 1000),
              $lt: days90Ago,
            },
          };
          break;
        case '1y':
        case 'yearly':
          const days365Ago = new Date(currentTime - 365 * 24 * 60 * 60 * 1000);
          dateFilter = { createdAt: { $gte: days365Ago } };
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(currentTime - 730 * 24 * 60 * 60 * 1000),
              $lt: days365Ago,
            },
          };
          break;
        case 'all':
        default:
          dateFilter = {};
          previousPeriodFilter = {};
          break;
      }
    }

    return { dateFilter, previousPeriodFilter };
  };

  const getRevenueRange = (period, startDate, endDate) => {
    const now = new Date();

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (isNaN(start.getTime()) || isNaN(end.getTime())) {
        throw new Error('Invalid date range provided');
      }

      return { start, end };
    }

    switch (period) {
      case '24h':
      case 'hourly':
        return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now };
      case '7d':
      case 'daily':
        return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), end: now };
      case '30d':
      case 'monthly':
        return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now };
      case '90d':
        return { start: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000), end: now };
      case '1y':
      case 'yearly':
        return { start: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000), end: now };
      case 'all':
        return { start: new Date(0), end: now };
      default:
        return { start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), end: now };
    }
  };

  // Create Stripe Checkout Session
  router.post('/api/create-checkout-session', async (req, res) => {
    try {
      return res.status(410).json({
        error: 'Subscription checkout has been removed. Please use Job Pass checkout.',
      });
    } catch (error) {
      console.error('create-checkout-session error:', error);
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  router.get('/api/subscription/checkout-session/:sessionId/verify', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { intent } = req.query;
      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['subscription', 'payment_intent'],
      });

      const syncResult = await syncCheckoutSessionToUser(checkoutSession, 'checkout_verify');

      if (!syncResult.paid) {
        const checkoutStatus = syncResult.status || checkoutSession.status;
        const shouldLogCheckoutCancel = intent === 'cancel' || checkoutStatus === 'expired';

        if (shouldLogCheckoutCancel) {
          const emailForCancel = syncResult.userEmail || checkoutSession.metadata?.userEmail || null;
          if (emailForCancel) {
            await upsertCheckoutCancelLog(emailForCancel, checkoutSession, 'checkout_verify', 'User cancelled checkout');
          }
        }

        const display = formatPurchaseDisplay(checkoutSession.metadata || {});
        return res.status(200).json({
          success: true,
          paid: false,
          status: checkoutStatus,
          paymentStatus: syncResult.paymentStatus || checkoutSession.payment_status,
          userEmail: syncResult.userEmail || checkoutSession.metadata?.userEmail || null,
          plan: checkoutSession.metadata?.plan || null,
          purchaseKind: display.purchaseKind,
          displayName: display.displayName,
          packQuantity: display.packQuantity,
          billingMode: checkoutSession.metadata?.billingMode || null,
          amount: typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total / 100 : 0,
          currency: (checkoutSession.currency || 'AUD').toUpperCase(),
        });
      }

      const display = formatPurchaseDisplay(checkoutSession.metadata || {});
      return res.json({
        success: true,
        paid: true,
        userEmail: syncResult.userEmail,
        plan: syncResult.plan,
        purchaseKind: display.purchaseKind,
        displayName: display.displayName,
        packQuantity: display.packQuantity,
        amount: syncResult.amount,
        currency: syncResult.currency,
        subscription: syncResult.subscription,
      });
    } catch (error) {
      console.error('checkout verify error:', error);
      return res.status(500).json({ error: 'Failed to verify checkout session' });
    }
  });

  router.get('/api/admin/analytics/job-pass-revenue', async (req, res) => {
    try {
      const { period = '30d', breakdown = 'daily', startDate, endDate } = req.query;
      const { start, end } = getRevenueRange(period, startDate, endDate);

      let groupBy = {};
      if (period === '24h' || period === 'hourly' || (breakdown === 'hourly' && (period === '7d' || period === '24h'))) {
        groupBy = {
          year: { $year: '$purchaseDate' },
          month: { $month: '$purchaseDate' },
          day: { $dayOfMonth: '$purchaseDate' },
          hour: { $hour: '$purchaseDate' },
        };
      } else if (breakdown === 'weekly' || period === '90d' || period === '1y' || period === 'yearly') {
        groupBy = {
          year: { $year: '$purchaseDate' },
          week: { $week: '$purchaseDate' },
        };
      } else if (breakdown === 'monthly' || period === 'monthly') {
        groupBy = {
          year: { $year: '$purchaseDate' },
          month: { $month: '$purchaseDate' },
        };
      } else {
        groupBy = {
          year: { $year: '$purchaseDate' },
          month: { $month: '$purchaseDate' },
          day: { $dayOfMonth: '$purchaseDate' },
        };
      }

      const addPurchaseDateStage = {
        $addFields: {
          purchaseDate: { $ifNull: ['$purchasedAt', '$createdAt'] },
        },
      };

      const inRangeMatch = {
        amountPaid: { $gt: 0 },
        status: { $nin: ['refunded', 'revoked'] },
        purchaseDate: { $gte: start, $lte: end },
      };

      const [timeRows, providerRows, skuRows, statusRows, funnelRows] = await Promise.all([
        jobPassesStorage
          .aggregate([
            addPurchaseDateStage,
            { $match: inRangeMatch },
            {
              $group: {
                _id: groupBy,
                revenue: { $sum: '$amountPaid' },
                count: { $sum: 1 },
                users: { $addToSet: { $ifNull: ['$userEmail', '$userId'] } },
              },
            },
            { $addFields: { uniqueUsers: { $size: '$users' } } },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1, '_id.week': 1 } },
          ])
          .toArray(),
        jobPassesStorage
          .aggregate([
            addPurchaseDateStage,
            { $match: inRangeMatch },
            {
              $group: {
                _id: '$paymentProvider',
                revenue: { $sum: '$amountPaid' },
                count: { $sum: 1 },
                users: { $addToSet: { $ifNull: ['$userEmail', '$userId'] } },
              },
            },
          ])
          .toArray(),
        jobPassesStorage
          .aggregate([
            addPurchaseDateStage,
            { $match: inRangeMatch },
            {
              $group: {
                _id: '$productSku',
                revenue: { $sum: '$amountPaid' },
                count: { $sum: 1 },
                users: { $addToSet: { $ifNull: ['$userEmail', '$userId'] } },
              },
            },
          ])
          .toArray(),
        jobPassesStorage
          .aggregate([
            addPurchaseDateStage,
            { $match: { purchaseDate: { $gte: start, $lte: end } } },
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 },
                revenue: { $sum: { $cond: [{ $gt: ['$amountPaid', 0] }, '$amountPaid', 0] } },
              },
            },
          ])
          .toArray(),
        offerAnalyticsStorage
          ? offerAnalyticsStorage
              .aggregate([
                {
                  $match: {
                    eventName: { $in: ['job_pass_checkout_started', 'job_pass_binding_failed'] },
                    createdAt: { $gte: start, $lte: end },
                  },
                },
                { $group: { _id: '$eventName', count: { $sum: 1 } } },
              ])
              .toArray()
          : Promise.resolve([]),
      ]);

      const totalRevenueMinor = timeRows.reduce((sum, row) => sum + (row.revenue || 0), 0);
      const totalTransactions = timeRows.reduce((sum, row) => sum + (row.count || 0), 0);
      const totalUniqueUsers = new Set(
        timeRows.flatMap((row) => row.users || []).filter((value) => Boolean(value)),
      ).size;

      const formatBreakdownData = (rows) =>
        rows.map((item) => {
          let dateLabel = '';
          if (item._id?.hour !== undefined) {
            dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')} ${String(item._id.hour).padStart(2, '0')}:00`;
          } else if (item._id?.week !== undefined) {
            dateLabel = `${item._id.year}-W${String(item._id.week).padStart(2, '0')}`;
          } else {
            dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
          }
          return {
            date: dateLabel,
            revenue: Number(((item.revenue || 0) / 100).toFixed(2)),
            transactions: item.count || 0,
            passBuyerEvents: item.count || 0,
            uniqueUsers: item.uniqueUsers || 0,
            uniquePassBuyers: item.uniqueUsers || 0,
            averageTransaction: item.count > 0 ? Number(((item.revenue || 0) / item.count / 100).toFixed(2)) : 0,
          };
        });

      const providerTotal = totalRevenueMinor > 0 ? totalRevenueMinor : 1;
      const byProvider = providerRows
        .map((row) => ({
          provider: row._id || 'unknown',
          revenue: Number(((row.revenue || 0) / 100).toFixed(2)),
          transactions: row.count || 0,
          uniqueUsers: new Set((row.users || []).filter((value) => Boolean(value))).size,
          averageTransaction: row.count > 0 ? Number(((row.revenue || 0) / row.count / 100).toFixed(2)) : 0,
          percentage: Number((((row.revenue || 0) / providerTotal) * 100).toFixed(1)),
        }))
        .sort((a, b) => b.revenue - a.revenue);

      const skuTotal = totalRevenueMinor > 0 ? totalRevenueMinor : 1;
      const bySku = skuRows
        .map((row) => ({
          productSku: row._id || 'unknown',
          revenue: Number(((row.revenue || 0) / 100).toFixed(2)),
          transactions: row.count || 0,
          uniqueUsers: new Set((row.users || []).filter((value) => Boolean(value))).size,
          averageTransaction: row.count > 0 ? Number(((row.revenue || 0) / row.count / 100).toFixed(2)) : 0,
          percentage: Number((((row.revenue || 0) / skuTotal) * 100).toFixed(1)),
        }))
        .sort((a, b) => b.revenue - a.revenue);

      const statusMap = statusRows.reduce((acc, row) => {
        acc[row._id] = {
          status: row._id,
          count: row.count || 0,
          revenue: Number(((row.revenue || 0) / 100).toFixed(2)),
        };
        return acc;
      }, {});

      const funnelMap = funnelRows.reduce((acc, row) => {
        acc[row._id] = row.count || 0;
        return acc;
      }, {});

      const completedPasses = (statusMap.active?.count || 0) + (statusMap.consumed?.count || 0);

      return res.json({
        success: true,
        period,
        breakdown,
        range: { from: start.toISOString(), to: end.toISOString() },
        summary: {
          totalRevenue: Number((totalRevenueMinor / 100).toFixed(2)),
          totalTransactions,
          passBuyerEvents: totalTransactions,
          totalUniqueUsers,
          uniquePassBuyers: totalUniqueUsers,
          averageTransaction: totalTransactions > 0 ? Number(((totalRevenueMinor / totalTransactions) / 100).toFixed(2)) : 0,
          completedPasses,
          checkoutStarted: funnelMap.job_pass_checkout_started || 0,
          bindingFailures: funnelMap.job_pass_binding_failed || 0,
        },
        timeBreakdown: formatBreakdownData(timeRows),
        byProvider,
        bySku,
        byStatus: Object.values(statusMap),
      });
    } catch (error) {
      console.error('Error fetching job pass revenue analytics:', error);
      res.status(500).json({ error: 'Failed to fetch job pass revenue analytics' });
    }
  });

  router.post('/api/webhooks/stripe', async (req, res) => {
    try {
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        return res.status(500).send('Webhook secret is not configured');
      }

      const signature = req.headers['stripe-signature'];
      if (!signature || !req.rawBody) {
        return res.status(400).send('Missing stripe-signature or raw body');
      }

      let event;
      try {
        event = stripe.webhooks.constructEvent(req.rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
      } catch (err) {
        console.error('Stripe webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      switch (event.type) {
        case 'checkout.session.completed': {
          const checkoutSession = event.data.object;
          // Job Pass one-off purchases share the Stripe webhook with Best Mates
          // subscriptions. Route them through the provider-agnostic binder so a
          // duplicate webhook (or replay after the success page already ran the
          // recovery path) cannot create a second pass row.
          const parsedJobPass = stripeProvider.parseCompletedCheckout(checkoutSession);
          if (parsedJobPass) {
            try {
              await bindPassToJob({
                mongoClient,
                jobPassesStorage,
                savedJobsStorage,
                subscriptionStorage,
                offerAnalyticsStorage,
                auditLogger,
                parsedEvent: parsedJobPass,
                rawEvent: { stripeEventId: event.id, type: event.type },
              });
            } catch (bindErr) {
              console.error('Job Pass bind via Stripe webhook failed:', bindErr?.message || bindErr);
              if (offerAnalyticsStorage) {
                try {
                  await offerAnalyticsStorage.insertOne({
                    eventName: 'job_pass_binding_failed',
                    paymentProvider: 'stripe',
                    providerOrderId: parsedJobPass.providerOrderId,
                    providerPaymentId: parsedJobPass.providerPaymentId,
                    jobId: parsedJobPass.jobId,
                    userEmail: parsedJobPass.userEmail,
                    reason: bindErr?.message || String(bindErr),
                    createdAt: new Date(),
                  });
                } catch (logErr) {
                  console.warn('Failed to log job_pass_binding_failed:', logErr?.message || logErr);
                }
              }
            }
            break;
          }
          await syncCheckoutSessionToUser(checkoutSession, 'webhook_checkout_completed');
          break;
        }

        case 'checkout.session.expired': {
          const checkoutSession = event.data.object;
          const checkoutEmail =
            checkoutSession.metadata?.userEmail || checkoutSession.customer_details?.email || checkoutSession.customer_email;

          if (checkoutEmail) {
            await upsertCheckoutCancelLog(checkoutEmail, checkoutSession, 'webhook_checkout_expired', 'Checkout session expired');
          }
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object;
          if (invoice.subscription) {
            const stripeSubscription = await stripe.subscriptions.retrieve(invoice.subscription);
            await syncStripeSubscriptionToUser(stripeSubscription, 'webhook_invoice_paid', event.id);
          }
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object;
          const stripeSubscriptionId =
            typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id || null;
          const customerId = typeof invoice.customer === 'string' ? invoice.customer : null;

          const user = await usersStorage.findOne({
            $or: [
              ...(stripeSubscriptionId ? [{ 'subscription.stripeSubscriptionId': stripeSubscriptionId }] : []),
              ...(customerId ? [{ 'subscription.stripeCustomerId': customerId }] : []),
            ],
          });

          if (user) {
            const nextSubscription = parseSubscriptionFields(user);
            if (nextSubscription.status !== 'past_due' || !nextSubscription.gracePeriodEndsAt) {
              nextSubscription.gracePeriodEndsAt = new Date(Date.now() + SUBSCRIPTION_GRACE_DAYS * 24 * 60 * 60 * 1000);
            }
            nextSubscription.status = 'past_due';
            await upsertSubscriptionState(user.userEmail, nextSubscription);
          }
          break;
        }

        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
          const stripeSubscription = event.data.object;
          await syncStripeSubscriptionToUser(stripeSubscription, `webhook_${event.type}`, event.id);
          break;
        }

        default:
          break;
      }

      return res.json({ received: true });
    } catch (error) {
      console.error('stripe webhook processing error:', error);
      return res.status(500).json({ error: 'Failed to process webhook' });
    }
  });

  router.get('/api/subscription/:userEmail', async (req, res) => {
    try {
      const { userEmail } = req.params;
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      let clerkUser = null;
      try {
        if (user.clerkId) {
          clerkUser = await clerkClient.users.getUser(user.clerkId);
        }
      } catch (clerkError) {}
      const usageMetrics = await calculateUsageMetrics({ userEmail, clerkId: user.clerkId });
      const lastActivity = usageMetrics.lastActivity || user.updatedAt || null;
      const subscriptionCore = parseSubscriptionFields(user);
      const now = new Date();

      const shouldExpireOneTime =
        subscriptionCore.status === 'active' &&
        subscriptionCore.billingMode === 'one_time' &&
        subscriptionCore.currentPeriodEnd &&
        now > new Date(subscriptionCore.currentPeriodEnd);

      const shouldExpireGrace =
        subscriptionCore.status === 'past_due' &&
        subscriptionCore.gracePeriodEndsAt &&
        now > new Date(subscriptionCore.gracePeriodEndsAt);

      if (shouldExpireOneTime || shouldExpireGrace) {
        subscriptionCore.status = 'inactive';
        subscriptionCore.plan = 'free';
        subscriptionCore.gracePeriodEndsAt = null;
        await upsertSubscriptionState(userEmail, subscriptionCore);
      }

      const healed = prepareSubscriptionForStore(subscriptionCore, now);
      const entitled = isSubscriptionEntitled(subscriptionCore, now);
      if (user.subscription?.plan !== healed.plan || Boolean(user.isSubscribed) !== entitled) {
        try {
          await upsertSubscriptionState(userEmail, subscriptionCore);
        } catch (persistError) {
          console.warn('Failed to self-heal subscription entitlement fields:', persistError);
        }
      }

      const subView = buildSubscriptionViewFromCore(subscriptionCore, now);

      const subscriptionData = {
        user: {
          id: user._id,
          userName: user.userName || 'Best Mates Subscription User',
          userEmail: user.userEmail,
          userImage: user.userImage || null,
          createdAt: user.createdAt || null,
          lastSignInAt: clerkUser?.lastSignInAt || null,
          role: user.role || 'user',
          isBanned: user.isBanned || false,
        },
        subscription: {
          isActive: subView.isActive,
          status: subView.status,
          plan: subView.plan,
          billingMode: subView.billingMode,
          startDate: subView.currentPeriodStart || user.createdAt || null,
          endDate: subView.currentPeriodEnd || null,
          customerId: subView.stripeCustomerId,
          subscriptionId: subView.stripeSubscriptionId,
          cancelAtPeriodEnd: subView.cancelAtPeriodEnd,
          gracePeriodEndsAt: subView.gracePeriodEndsAt,
          isScheduledForCancellation: subView.isScheduledForCancellation,
          scheduledCancellationEffectiveAt: subView.scheduledCancellationEffectiveAt,
          cancellationMessage: subView.cancellationMessage,
        },
        usage: {
          totalSessions: usageMetrics.totalJobSession,
          totalJobSession: usageMetrics.totalJobSession,
          totalSavedJob: usageMetrics.totalSavedJob,
          totalMessages: usageMetrics.totalMessages,
          toolsInShed: usageMetrics.totalSheds,
          totalSheds: usageMetrics.totalSheds,
          totalSuggestedTools: usageMetrics.totalSuggestedTools,
          lastActivity,
        },
      };
      res.json(subscriptionData);
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch subscription details' });
    }
  });

  router.get('/api/subscription/:userEmail/purchase-logs', async (req, res) => {
    try {
      const { userEmail } = req.params;
      const { page = 1, limit = 10 } = req.query;
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const userIdToQuery = user.clerkId || userEmail;
      const purchaseLogsQuery = {
        $or: [{ userEmail: userEmail }, { userId: userIdToQuery }, { clerkId: user.clerkId }],
      };
      const totalLogs = await subscriptionStorage.countDocuments(purchaseLogsQuery);
      const purchaseLogs = await subscriptionStorage
        .find(purchaseLogsQuery)
        .sort({ date: -1, createdAt: -1, timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(Number.parseInt(limit))
        .toArray();
      const normalizePurchaseDisplayAmount = (log) => {
        const raw = typeof log.amount === 'number' ? log.amount : Number(log.amount) || 0;
        const md = log.metadata || {};
        if (
          log.type === 'job_pass_checkout' &&
          md.paymentProvider === 'paypal' &&
          Number.isFinite(raw) &&
          raw >= 100 &&
          Number.isInteger(raw)
        ) {
          return Number((raw / 100).toFixed(2));
        }
        return raw;
      };

      const formattedLogs = purchaseLogs.map((log) => ({
        id: log._id.toString(),
        type: log.type || log.action || 'transaction',
        description: log.description || log.title || 'Transaction',
        amount: normalizePurchaseDisplayAmount(log),
        currency: log.currency || 'AUD',
        status: log.status || 'completed',
        date: log.date || log.createdAt || log.timestamp || new Date(),
        reason: log.reason || null,
        feedback: log.feedback || null,
        metadata: log.metadata || {},
      }));
      res.json({
        purchaseLogs: formattedLogs,
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(totalLogs / limit),
          totalLogs: totalLogs,
          hasNext: page * limit < totalLogs,
          hasPrev: page > 1,
        },
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch purchase logs' });
    }
  });

  router.post('/api/subscription/:userEmail/purchase-logs', async (req, res) => {
    try {
      const { userEmail } = req.params;
      const { type, description, amount, currency, status, reason, feedback, metadata } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      if (metadata?.idempotencyKey) {
        const existingByIdempotencyKey = await subscriptionStorage.findOne({
          userEmail,
          'metadata.idempotencyKey': metadata.idempotencyKey,
        });
        if (existingByIdempotencyKey) {
          return res.status(200).json({
            success: true,
            message: 'Purchase log already recorded',
            logId: existingByIdempotencyKey._id.toString(),
          });
        }
      }

      if (metadata?.stripeSessionId) {
        const existingLog = await subscriptionStorage.findOne({
          userEmail,
          'metadata.stripeSessionId': metadata.stripeSessionId,
          status: status || 'completed',
        });
        if (existingLog) {
          console.warn(
            `Duplicate purchase log attempt detected for user: ${userEmail}, stripeSessionId: ${metadata.stripeSessionId}, status: ${status || 'completed'}. Returning existing log.`
          );
          return res.status(200).json({
            success: true,
            message: 'Purchase already logged',
            logId: existingLog._id.toString(),
          });
        }
      } else {
        console.warn(
          `Warning: stripeSessionId missing for purchase log for user ${userEmail}. Duplicate check might be less effective.`
        );
      }
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      if (!type || !description) {
        return res.status(400).json({ error: 'Type and description are required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const logEntry = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: type,
        description: description,
        amount: amount || 0,
        currency: currency || 'AUD',
        status: status || 'completed',
        date: new Date(),
        createdAt: new Date(),
        reason: reason || null,
        feedback: feedback || null,
        metadata: {
          ...metadata,
          ...userInfo,
          addedBy: 'system',
        },
      };
      const result = await subscriptionStorage.insertOne(logEntry);
      if (type === 'purchase' && metadata?.source === 'trusted_webhook') {
        const trustedSubscription = parseSubscriptionFields(user);
        const nextTrusted = {
          ...trustedSubscription,
          status: 'active',
          plan: 'premium',
          gracePeriodEndsAt: null,
        };
        await upsertSubscriptionState(userEmail, nextTrusted);
      }
      await auditLogger.logAudit({
        action: 'CREATE_PURCHASE_LOG',
        resource: 'subscription_log',
        resourceId: result.insertedId.toString(),
        userId: user._id.toString(),
        userEmail: userEmail,
        role: user.role || 'user',
        newData: logEntry,
        metadata: {
          logType: type,
          ...userInfo,
        },
      });
      res.json({
        success: true,
        message: 'Purchase log added successfully',
        logId: result.insertedId,
        log: {
          ...logEntry,
          id: result.insertedId.toString(),
        },
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to add purchase log' });
    }
  });

  router.post('/api/subscription/:userEmail/cancel', async (req, res) => {
    try {
      return res.status(410).json({
        error: 'Subscription cancellation has been removed. Use Job Pass purchase history only.',
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });

  router.post('/api/subscription/:userEmail/reactivate', async (req, res) => {
    try {
      return res.status(410).json({
        error: 'Subscription reactivation has been removed. Use Job Pass checkout instead.',
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reactivate subscription' });
    }
  });

  router.get('/api/subscription/:userEmail/usage', async (req, res) => {
    const { userEmail } = req.params;
    return res.redirect(307, `/api/subscription/${encodeURIComponent(userEmail)}/usage-details`);
  });

  // Job Pass-first customer profile compatibility contracts.
  router.get('/api/customer-profile/:userEmail', async (req, res) => {
    const { userEmail } = req.params;
    return res.redirect(307, `/api/subscription/${encodeURIComponent(userEmail)}`);
  });

  router.get('/api/customer-profile/:userEmail/usage', async (req, res) => {
    const { userEmail } = req.params;
    return res.redirect(307, `/api/subscription/${encodeURIComponent(userEmail)}/usage-details`);
  });

  router.get('/api/customer-profile/:userEmail/billing-events', async (req, res) => {
    const { userEmail } = req.params;
    const queryString = new URLSearchParams(req.query || {}).toString();
    const suffix = queryString ? `?${queryString}` : '';
    return res.redirect(307, `/api/subscription/${encodeURIComponent(userEmail)}/purchase-logs${suffix}`);
  });

  router.get('/api/subscription/:userEmail/usage-details', async (req, res) => {
    try {
      const { userEmail } = req.params;
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const filters = getUserIdentityFilters(userEmail, user.clerkId);
      const [usageMetrics, sessionStats, shedStats] = await Promise.all([
        calculateUsageMetrics({ userEmail, clerkId: user.clerkId }),
        mateyChatSessionsStorage
          ? mateyChatSessionsStorage
              .aggregate([
                { $match: filters.sessionFilter },
                {
                  $group: {
                    _id: null,
                    totalSessions: { $sum: 1 },
                    totalMessages: { $sum: { $ifNull: ['$messageCount', 0] } },
                    totalConversations: { $sum: 1 },
                    lastSession: { $max: '$lastMessageAt' },
                  },
                },
              ])
              .toArray()
          : [{ totalSessions: 0, totalMessages: 0, totalConversations: 0, lastSession: null }],
        shedToolsStorage
          ? shedToolsStorage
              .aggregate([
                { $match: filters.shedFilter },
                {
                  $group: {
                    _id: '$category',
                    count: { $sum: 1 },
                    tools: { $push: '$tool_name' },
                  },
                },
              ])
              .toArray()
          : [],
      ]);
      const sessionData = sessionStats[0] || { totalSessions: 0, totalMessages: 0, totalConversations: 0, lastSession: null };

      res.json({
        sessions: {
          total: sessionData.totalSessions,
          flagged: 0,
          lastActivity: sessionData.lastSession,
          budgetTierDistribution: {},
        },
        messages: {
          total: sessionData.totalMessages,
          conversations: sessionData.totalConversations,
          averagePerConversation:
            sessionData.totalConversations > 0
              ? Math.round((sessionData.totalMessages / sessionData.totalConversations) * 100) / 100
              : 0,
        },
        shed: {
          totalTools: shedStats.reduce((sum, category) => sum + category.count, 0),
          categories: shedStats.map((cat) => ({
            name: cat._id || 'Other',
            count: cat.count,
            tools: cat.tools,
          })),
        },
        totals: usageMetrics,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch usage details' });
    }
  });

  router.get('/api/admin/analytics/subscriptions', async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req);
      const { period = '30d', startDate, endDate } = req.query;
      const { dateFilter, previousPeriodFilter } = getDateFilters(period, startDate, endDate);
      const now = new Date();

      const [
        totalUsers,
        activeSubscriptions,
        newUsersInPeriod,
        newSubscriptionsInPeriod,
        totalRevenue,
        revenueInPeriod,
        cancellationsInPeriod,
        reactivationsInPeriod,
        recentActivity,
      ] = await Promise.all([
        usersStorage.countDocuments({}),
        usersStorage.countDocuments({ 'subscription.status': 'active' }),
        usersStorage.countDocuments(dateFilter),
        subscriptionStorage.countDocuments({
          type: { $in: ['purchase', 'reactivation'] },
          status: 'completed',
          ...dateFilter,
        }),
        subscriptionStorage
          .aggregate([
            { $match: { type: 'purchase', status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ])
          .toArray(),
        subscriptionStorage
          .aggregate([
            {
              $match: {
                type: 'purchase',
                status: 'completed',
                ...dateFilter,
              },
            },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ])
          .toArray(),
        subscriptionStorage.countDocuments({
          type: 'cancellation',
          ...dateFilter,
        }),
        subscriptionStorage.countDocuments({
          type: 'reactivation',
          ...dateFilter,
        }),
        subscriptionStorage.find(dateFilter).sort({ createdAt: -1 }).limit(10).toArray(),
      ]);

      const totalRevenueAmount = totalRevenue[0]?.total || 0;
      const periodRevenueAmount = revenueInPeriod[0]?.total || 0;
      const conversionRate = totalUsers > 0 ? ((activeSubscriptions / totalUsers) * 100).toFixed(2) : 0;
      let growthMetrics = {};
      let historicalConversionRate = [];
      let historicalUserGrowth = [];

      if (period !== 'all' && period !== '90d' && period !== '1y') {
        const [
          previousUsers,
          previousRevenue,
          previousSubscriptions,
          previousCancellations,
          previousNetSubscriptionChange,
          historicalData,
        ] = await Promise.all([
          usersStorage.countDocuments(previousPeriodFilter),
          subscriptionStorage
            .aggregate([
              {
                $match: {
                  type: 'purchase',
                  status: 'completed',
                  ...previousPeriodFilter,
                },
              },
              { $group: { _id: null, total: { $sum: '$amount' } } },
            ])
            .toArray(),
          subscriptionStorage.countDocuments({
            type: { $in: ['purchase', 'reactivation'] },
            status: 'completed',
            ...previousPeriodFilter,
          }),
          subscriptionStorage.countDocuments({
            type: 'cancellation',
            ...previousPeriodFilter,
          }),
          (async () => {
            const prevNewSubs = await subscriptionStorage.countDocuments({
              type: { $in: ['purchase', 'reactivation'] },
              status: 'completed',
              ...previousPeriodFilter,
            });
            const prevCancellations = await subscriptionStorage.countDocuments({
              type: 'cancellation',
              ...previousPeriodFilter,
            });
            return prevNewSubs - prevCancellations;
          })(),
          subscriptionStorage
            .aggregate([
              {
                $match: {
                  createdAt: {
                    $gte: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
                    $lte: now,
                  },
                },
              },
              {
                $group: {
                  _id: {
                    year: { $year: '$createdAt' },
                    month: { $month: '$createdAt' },
                    day: { $dayOfMonth: '$createdAt' },
                  },
                  newUsers: { $sum: { $cond: [{ $eq: ['$type', 'user_signup'] }, 1, 0] } },
                  activeSubscriptions: { $sum: { $cond: [{ $eq: ['$type', 'purchase'] }, 1, 0] } },
                  totalUsers: { $sum: 1 },
                },
              },
              {
                $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 },
              },
            ])
            .toArray(),
        ]);

        const prevRevenueAmount = previousRevenue[0]?.total || 0;
        const prevConversionRate = previousUsers > 0 ? ((previousSubscriptions / previousUsers) * 100).toFixed(2) : 0;

        growthMetrics = {
          userGrowth: previousUsers > 0 ? (((newUsersInPeriod - previousUsers) / previousUsers) * 100).toFixed(2) : 0,
          revenueGrowth:
            prevRevenueAmount > 0
              ? (((periodRevenueAmount - prevRevenueAmount) / prevRevenueAmount) * 100).toFixed(2)
              : 0,
          subscriptionGrowth:
            previousSubscriptions > 0
              ? (((newSubscriptionsInPeriod - previousSubscriptions) / previousSubscriptions) * 100).toFixed(2)
              : 0,
          conversionRateGrowth:
            prevConversionRate > 0
              ? (
                  ((Number.parseFloat(conversionRate) - Number.parseFloat(prevConversionRate)) /
                    Number.parseFloat(prevConversionRate)) *
                  100
                ).toFixed(2)
              : 0,
          newSubscriptionsGrowth:
            previousSubscriptions > 0
              ? (((newSubscriptionsInPeriod - previousSubscriptions) / previousSubscriptions) * 100).toFixed(2)
              : 0,
          netSubscriptionChangeGrowth:
            previousNetSubscriptionChange !== 0
              ? (
                  ((newSubscriptionsInPeriod +
                    reactivationsInPeriod -
                    cancellationsInPeriod -
                    previousNetSubscriptionChange) /
                    Math.abs(previousNetSubscriptionChange)) *
                  100
                ).toFixed(2)
              : 0,
          cancellationsGrowth:
            previousCancellations > 0
              ? (((cancellationsInPeriod - previousCancellations) / previousCancellations) * 100).toFixed(2)
              : 0,
        };

        let runningTotalUsers = 0;
        let runningActiveSubs = 0;
        historicalConversionRate = historicalData.map((item) => {
          runningTotalUsers += item.newUsers;
          runningActiveSubs += item.activeSubscriptions;
          return {
            date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(
              2,
              '0'
            )}`,
            conversionRate: runningTotalUsers > 0 ? (runningActiveSubs / runningTotalUsers) * 100 : 0,
          };
        });

        historicalUserGrowth = historicalData.map((item) => ({
          date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
          newUsers: item.newUsers,
        }));
      }

      res.json({
        period,
        overview: {
          totalUsers,
          activeSubscriptions,
          freeUsers: totalUsers - activeSubscriptions,
          totalRevenue: totalRevenueAmount,
          conversionRate: `${conversionRate}%`,
        },
        periodMetrics: {
          newUsers: newUsersInPeriod,
          newSubscriptions: newSubscriptionsInPeriod,
          revenue: periodRevenueAmount,
          cancellations: cancellationsInPeriod,
          reactivations: reactivationsInPeriod,
          netSubscriptionChange: newSubscriptionsInPeriod + reactivationsInPeriod - cancellationsInPeriod,
        },
        growthMetrics,
        recentActivity: recentActivity.map((activity) => ({
          id: activity._id,
          userEmail: activity.userEmail,
          type: activity.type,
          description: activity.description,
          amount: activity.amount,
          status: activity.status,
          date: activity.createdAt,
        })),
        historicalConversionRate,
        historicalUserGrowth,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch analytics' });
    }
  });

  router.get('/api/admin/users', async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req);
      const {
        page = 1,
        limit = 20,
        status = 'all',
        search = '',
        period = 'all',
        sortBy = 'createdAt',
        sortOrder = 'desc',
      } = req.query;
      let query = {};
      if (period !== 'all') {
        const now = new Date();
        let dateFilter = {};
        switch (period) {
          case '24h':
            dateFilter = { createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } };
            break;
          case '7d':
            dateFilter = { createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } };
            break;
          case '30d':
            dateFilter = { createdAt: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } };
            break;
        }
        query = { ...query, ...dateFilter };
      }
      if (status === 'active') {
        query['subscription.status'] = 'active';
      } else if (status === 'inactive') {
        query.$and = query.$and || [];
        query.$and.push({
          $or: [
            { 'subscription.status': { $exists: false } },
            { 'subscription.status': { $ne: 'active' } },
          ],
        });
      }
      if (search) {
        query.$or = [{ userEmail: { $regex: search, $options: 'i' } }, { userName: { $regex: search, $options: 'i' } }];
      }
      const sortOptions = {};
      sortOptions[sortBy] = sortOrder === 'asc' ? 1 : -1;
      const totalUsers = await usersStorage.countDocuments(query);
      const users = await usersStorage
        .find(query)
        .sort(sortOptions)
        .skip((page - 1) * limit)
        .limit(Number.parseInt(limit))
        .toArray();
      const usersWithStats = await Promise.all(
        users.map(async (user) => {
          const usageMetrics = await calculateUsageMetrics({ userEmail: user.userEmail, clerkId: user.clerkId });
          return {
            id: user._id,
            userName: user.userName || 'Best Mates Subscription',
            userEmail: user.userEmail,
            userImage: user.userImage,
            isSubscribed: isUserPro(user),
            isPro: isUserPro(user),
            subscription: normalizeSubscription(user),
            role: user.role || 'user',
            isBanned: user.isBanned || false,
            createdAt: user.createdAt,
            lastActivity: usageMetrics.lastActivity || user.updatedAt,
            usage: {
              sessions: usageMetrics.totalJobSession,
              savedJobs: usageMetrics.totalSavedJob,
              messages: usageMetrics.totalMessages,
              tools: usageMetrics.totalSheds,
              suggestedTools: usageMetrics.totalSuggestedTools,
            },
          };
        })
      );
      res.json({
        users: usersWithStats,
        filters: {
          period,
          status,
          search,
          sortBy,
          sortOrder,
        },
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(totalUsers / limit),
          totalUsers: totalUsers,
          hasNext: page * limit < totalUsers,
          hasPrev: page > 1,
        },
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  router.get('/api/admin/analytics/revenue', async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req);
      const { period = '30d', breakdown = 'daily', startDate, endDate } = req.query;
      const { dateFilter } = getDateFilters(period, startDate, endDate);
      let groupBy = {};
      if (period === '24h' || period === 'hourly') {
        groupBy = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
          hour: { $hour: '$createdAt' },
        };
      } else if (breakdown === 'hourly' && (period === '7d' || period === '24h')) {
        groupBy = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
          hour: { $hour: '$createdAt' },
        };
      } else if (breakdown === 'weekly' || period === '90d' || period === '1y' || period === 'yearly') {
        groupBy = {
          year: { $year: '$createdAt' },
          week: { $week: '$createdAt' },
        };
      } else if (breakdown === 'monthly' || period === 'monthly') {
        groupBy = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
        };
      } else {
        groupBy = {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
          day: { $dayOfMonth: '$createdAt' },
        };
      }
      const [revenueData, totalStats, subscriptionTypes] = await Promise.all([
        subscriptionStorage
          .aggregate([
            {
              $match: {
                type: 'purchase',
                status: 'completed',
                ...dateFilter,
              },
            },
            {
              $group: {
                _id: groupBy,
                revenue: { $sum: '$amount' },
                count: { $sum: 1 },
                users: { $addToSet: '$userEmail' },
              },
            },
            {
              $addFields: {
                uniqueUsers: { $size: '$users' },
              },
            },
            {
              $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1, '_id.week': 1 },
            },
          ])
          .toArray(),
        subscriptionStorage
          .aggregate([
            {
              $match: {
                type: { $in: ['purchase', 'cancellation', 'reactivation'] },
                ...dateFilter,
              },
            },
            {
              $group: {
                _id: '$type',
                count: { $sum: 1 },
                revenue: { $sum: '$amount' },
              },
            },
          ])
          .toArray(),
        subscriptionStorage
          .aggregate([
            {
              $match: {
                type: 'purchase',
                status: 'completed',
                ...dateFilter,
              },
            },
            {
              $group: {
                _id: '$metadata.plan',
                count: { $sum: 1 },
                revenue: { $sum: '$amount' },
              },
            },
          ])
          .toArray(),
      ]);
      const statsMap = totalStats.reduce((acc, stat) => {
        acc[stat._id] = stat;
        return acc;
      }, {});
      const totalRevenue = revenueData.reduce((sum, item) => sum + item.revenue, 0);
      const totalTransactions = revenueData.reduce((sum, item) => sum + item.count, 0);
      const totalUniqueUsers = new Set(revenueData.flatMap((item) => item.users || [])).size;
      const formatBreakdownData = (data) => {
        return data.map((item) => {
          let dateLabel = '';
          if (item._id.hour !== undefined) {
            dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(
              2,
              '0'
            )} ${String(item._id.hour).padStart(2, '0')}:00`;
          } else if (item._id.week !== undefined) {
            dateLabel = `${item._id.year}-W${String(item._id.week).padStart(2, '0')}`;
          } else {
            dateLabel = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(
              2,
              '0'
            )}`;
          }
          return {
            date: dateLabel,
            revenue: item.revenue,
            transactions: item.count,
            uniqueUsers: item.uniqueUsers,
            averageTransaction: item.count > 0 ? (item.revenue / item.count).toFixed(2) : 0,
          };
        });
      };
      res.json({
        period,
        breakdown,
        summary: {
          totalRevenue,
          totalTransactions,
          totalUniqueUsers,
          averageTransaction: totalTransactions > 0 ? (totalRevenue / totalTransactions).toFixed(2) : 0,
          purchases: statsMap.purchase?.count || 0,
          cancellations: statsMap.cancellation?.count || 0,
          reactivations: statsMap.reactivation?.count || 0,
        },
        timeBreakdown: formatBreakdownData(revenueData),
        subscriptionTypes: subscriptionTypes.map((type) => ({
          plan: type._id || 'Best Mates Subscription',
          count: type.count,
          revenue: type.revenue,
          percentage: totalRevenue > 0 ? ((type.revenue / totalRevenue) * 100).toFixed(2) : 0,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch revenue analytics' });
    }
  });

  router.get('/api/admin/analytics/activity', async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req);
      const { period = '30d' } = req.query;
      let dateFilter = {};
      const now = new Date();
      const currentTime = now.getTime();
      switch (period) {
        case '24h':
        case 'hourly':
          dateFilter = { timestamp: { $gte: new Date(currentTime - 24 * 60 * 60 * 1000) } };
          break;
        case '7d':
        case 'daily':
          dateFilter = { timestamp: { $gte: new Date(currentTime - 7 * 24 * 60 * 60 * 1000) } };
          break;
        case '30d':
        case 'monthly':
          dateFilter = { timestamp: { $gte: new Date(currentTime - 30 * 24 * 60 * 60 * 1000) } };
          break;
        case '90d':
          dateFilter = { timestamp: { $gte: new Date(currentTime - 90 * 24 * 60 * 60 * 1000) } };
          break;
        case '1y':
        case 'yearly':
          dateFilter = { timestamp: { $gte: new Date(currentTime - 365 * 24 * 60 * 60 * 1000) } };
          break;
        default:
          dateFilter = {};
          break;
      }
      const [sessionActivity, messageActivity, toolActivity] = await Promise.all([
        sessionsStorage
          ? sessionsStorage
              .aggregate([
                { $match: dateFilter },
                {
                  $group: {
                    _id: {
                      year: { $year: '$timestamp' },
                      month: { $month: '$timestamp' },
                      day: { $dayOfMonth: '$timestamp' },
                    },
                    sessions: { $sum: 1 },
                    uniqueUsers: { $addToSet: '$userEmail' },
                    flaggedSessions: { $sum: { $cond: ['$flagTriggered', 1, 0] } },
                  },
                },
                {
                  $addFields: {
                    uniqueUserCount: { $size: '$uniqueUsers' },
                  },
                },
                { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
              ])
              .toArray()
          : [],
        messagesStorage
          ? messagesStorage
              .aggregate([
                { $match: dateFilter },
                {
                  $project: {
                    timestamp: 1,
                    userEmail: 1,
                    messageCount: { $size: { $ifNull: ['$messages', []] } },
                  },
                },
                {
                  $group: {
                    _id: {
                      year: { $year: '$timestamp' },
                      month: { $month: '$timestamp' },
                      day: { $dayOfMonth: '$timestamp' },
                    },
                    totalMessages: { $sum: '$messageCount' },
                    conversations: { $sum: 1 },
                    uniqueUsers: { $addToSet: '$userEmail' },
                  },
                },
                {
                  $addFields: {
                    uniqueUserCount: { $size: '$uniqueUsers' },
                  },
                },
                { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
              ])
              .toArray()
          : [],
        shedToolsStorage
          ? shedToolsStorage
              .aggregate([
                {
                  $match: {
                    collection: { $ne: 'shed_analytics' },
                    ...(dateFilter.timestamp ? { created_at: dateFilter.timestamp } : {}),
                  },
                },
                {
                  $group: {
                    _id: '$category',
                    count: { $sum: 1 },
                    uniqueUsers: { $addToSet: '$user_id' },
                  },
                },
                {
                  $addFields: {
                    uniqueUserCount: { $size: '$uniqueUsers' },
                  },
                },
              ])
              .toArray()
          : [],
      ]);
      res.json({
        period,
        sessionActivity: sessionActivity.map((item) => ({
          date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
          sessions: item.sessions,
          uniqueUsers: item.uniqueUserCount,
          flaggedSessions: item.flaggedSessions,
        })),
        messageActivity: messageActivity.map((item) => ({
          date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
          messages: item.totalMessages,
          conversations: item.conversations,
          uniqueUsers: item.uniqueUserCount,
          averageMessagesPerConversation:
            item.conversations > 0 ? (item.totalMessages / item.conversations).toFixed(2) : 0,
        })),
        toolActivity: toolActivity.map((item) => ({
          category: item._id || 'Other',
          count: item.count,
          uniqueUsers: item.uniqueUserCount,
        })),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch activity analytics' });
    }
  });

  router.get('/api/admin/analytics/mrr-arr', async (req, res) => {
    try {
      const { period = '30d', startDate, endDate } = req.query;
      const { dateFilter } = getDateFilters(period, startDate, endDate);
      const now = new Date();
      const activeSubscriptions = await usersStorage.find({ 'subscription.status': 'active' }).toArray();
      let mrr = 0;
      for (const user of activeSubscriptions) {
        const latestPurchase = await subscriptionStorage.findOne(
          {
            userEmail: user.userEmail,
            type: 'purchase',
            status: 'completed',
            createdAt: { $lte: now },
          },
          { sort: { createdAt: -1 } }
        );
        if (latestPurchase && latestPurchase.amount) {
          mrr += latestPurchase.amount;
        }
      }
      const arr = mrr * 12;
      res.json({
        period,
        mrr,
        arr,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch MRR and ARR' });
    }
  });

  router.get('/api/admin/analytics/churn-rate', async (req, res) => {
    try {
      const { period = '30d', startDate, endDate } = req.query;
      const { dateFilter } = getDateFilters(period, startDate, endDate);
      const [cancellationsInPeriod, activeSubscriptions] = await Promise.all([
        subscriptionStorage.countDocuments({
          type: 'cancellation',
          ...dateFilter,
        }),
        usersStorage.countDocuments({ 'subscription.status': 'active' }),
      ]);
      const churnRate =
        activeSubscriptions + cancellationsInPeriod > 0
          ? (cancellationsInPeriod / (activeSubscriptions + cancellationsInPeriod)) * 100
          : 0;
      res.json({
        period,
        churnRate: Number.parseFloat(churnRate.toFixed(2)),
        cancellations: cancellationsInPeriod,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch churn rate' });
    }
  });

  router.get('/api/admin/analytics/ltv-arpu', async (req, res) => {
    try {
      const { period = '30d', startDate, endDate } = req.query;
      const { dateFilter } = getDateFilters(period, startDate, endDate);
      const [totalRevenueResult, totalUniqueUsers, churnRateData] = await Promise.all([
        subscriptionStorage
          .aggregate([
            { $match: { type: 'purchase', status: 'completed', ...dateFilter } },
            { $group: { _id: null, total: { $sum: '$amount' }, uniqueUsers: { $addToSet: '$userEmail' } } },
          ])
          .toArray(),
        usersStorage.countDocuments({}),
        subscriptionStorage.countDocuments({ type: 'cancellation', ...dateFilter }),
      ]);
      const totalRevenue = totalRevenueResult[0]?.total || 0;
      const uniquePayingUsersInPeriod = totalRevenueResult[0]?.uniqueUsers?.length || 0;
      const totalUsers = totalUniqueUsers;
      const arpu = totalUsers > 0 ? totalRevenue / totalUsers : 0;
      const activeSubscriptions = await usersStorage.countDocuments({ 'subscription.status': 'active' });
      const churnRate =
        activeSubscriptions + churnRateData > 0 ? churnRateData / (activeSubscriptions + churnRateData) : 0;
      const ltv = churnRate > 0 ? arpu / churnRate : 0;
      res.json({
        period,
        arpu: Number.parseFloat(arpu.toFixed(2)),
        ltv: Number.parseFloat(ltv.toFixed(2)),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch LTV and ARPU' });
    }
  });

  router.get('/api/admin/analytics/billing-issues', async (req, res) => {
    try {
      const { period = '30d', startDate, endDate } = req.query;
      const { dateFilter } = getDateFilters(period, startDate, endDate);
      const [totalTransactions, refunds, failedPayments] = await Promise.all([
        subscriptionStorage.countDocuments({ type: 'purchase', status: 'completed', ...dateFilter }),
        subscriptionStorage
          .aggregate([
            { $match: { type: 'refund', ...dateFilter } },
            { $group: { _id: null, count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
          ])
          .toArray(),
        subscriptionStorage
          .aggregate([
            { $match: { status: 'failed', ...dateFilter } },
            { $group: { _id: null, count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
          ])
          .toArray(),
      ]);
      const refundsCount = refunds[0]?.count || 0;
      const refundsValue = refunds[0]?.totalAmount || 0;
      const failedPaymentsCount = failedPayments[0]?.count || 0;
      const failedPaymentsValue = failedPayments[0]?.totalAmount || 0;
      const refundRate = totalTransactions > 0 ? (refundsCount / totalTransactions) * 100 : 0;
      res.json({
        period,
        refundRate: Number.parseFloat(refundRate.toFixed(2)),
        refundsCount,
        refundsValue,
        failedPaymentsCount,
        failedPaymentsValue,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to fetch billing issues' });
    }
  });
  router.get('/api/admin/analytics/cohort-retention', async (req, res) => {
    try {
      const { period = '30d', startDate, endDate } = req.query;
      const { dateFilter } = getDateFilters(period, startDate, endDate);
      const usersInPeriod = await usersStorage.find(dateFilter).toArray();
      if (usersInPeriod.length === 0) {
        return res.json([]);
      }
      const cohortsMap = new Map();
      for (const user of usersInPeriod) {
        const signupDate = user.createdAt;
        if (signupDate) {
          const cohortMonth = format(signupDate, 'yyyy-MM');
          if (!cohortsMap.has(cohortMonth)) {
            cohortsMap.set(cohortMonth, { users: [], count: 0 });
          }
          cohortsMap.get(cohortMonth).users.push(user);
          cohortsMap.get(cohortMonth).count++;
        }
      }
      const sortedCohorts = Array.from(cohortsMap.keys()).sort();
      const retentionData = [];
      const startPeriod = startDate ? new Date(startDate) : new Date(new Date().getTime() - 180 * 24 * 60 * 60 * 1000);
      const endPeriod = endDate ? new Date(endDate) : new Date();
      const totalMonthsToTrack = Math.min(differenceInMonths(endPeriod, startPeriod) + 1, 12);
      for (const cohortMonth of sortedCohorts) {
        const cohortUsers = cohortsMap.get(cohortMonth).users;
        const initialCohortSize = cohortsMap.get(cohortMonth).count;
        if (initialCohortSize === 0) continue;
        const cohortRow = {
          month: cohortMonth,
          initial: initialCohortSize,
          cohortDate: new Date(cohortMonth + '-01'),
        };
        for (let i = 0; i < totalMonthsToTrack; i++) {
          const targetMonth = addMonths(new Date(cohortMonth + '-01'), i);
          const targetMonthStart = startOfMonth(targetMonth);
          const targetMonthEnd = endOfMonth(targetMonth);
          let activeInMonthCount = 0;
          for (const user of cohortUsers) {
            const wasActiveInMonth = await checkUserActiveInMonth(
              user,
              targetMonthStart,
              targetMonthEnd,
              subscriptionStorage
            );
            if (wasActiveInMonth) {
              activeInMonthCount++;
            }
          }
          const retentionPercentage = (activeInMonthCount / initialCohortSize) * 100;
          cohortRow[`month${i}`] = Number.parseFloat(retentionPercentage.toFixed(2));
        }
        retentionData.push(cohortRow);
      }
      res.json(retentionData);
    } catch (error) {
      console.error('Cohort retention error:', error);
      res.status(500).json({ error: 'Failed to fetch cohort retention data' });
    }
  });
  async function checkUserActiveInMonth(user, monthStart, monthEnd, subscriptionStorage) {
    try {
      if (isUserPro(user) && user.createdAt <= monthEnd) {
        const cancellation = await subscriptionStorage.findOne(
          {
            userEmail: user.userEmail,
            type: 'cancellation',
            createdAt: { $lte: monthEnd },
          },
          { sort: { createdAt: -1 } }
        );
        if (!cancellation) {
          return true;
        }
        const reactivation = await subscriptionStorage.findOne({
          userEmail: user.userEmail,
          type: 'reactivation',
          createdAt: { $gt: cancellation.createdAt, $lte: monthEnd },
        });
        return !!reactivation;
      }
      const lastSubscriptionEvent = await subscriptionStorage.findOne(
        {
          userEmail: user.userEmail,
          type: { $in: ['purchase', 'reactivation', 'cancellation'] },
          createdAt: { $lte: monthEnd },
        },
        { sort: { createdAt: -1 } }
      );
      if (!lastSubscriptionEvent) {
        return false;
      }
      if (lastSubscriptionEvent.type === 'purchase' || lastSubscriptionEvent.type === 'reactivation') {
        return true;
      }
      return false;
    } catch (error) {
      console.error('Error checking user activity:', error);
      return false;
    }
  }
  return router;
};
