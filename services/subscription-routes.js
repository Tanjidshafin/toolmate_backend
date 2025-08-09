const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { format, differenceInMonths, startOfMonth, endOfMonth, addMonths, differenceInDays } = require('date-fns');

module.exports = (dependencies) => {
  const {
    usersStorage,
    auditLogger,
    clerkClient,
    ObjectId,
    getUserInfoFromRequest,
    sessionsStorage,
    messagesStorage,
    shedToolsStorage,
    subscriptionStorage,
  } = dependencies;

  const router = express.Router();

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

  // Create Stripe Checkout Session
  router.post('/api/create-checkout-session', async (req, res) => {
    try {
      const { userEmail, plan, amount } = req.body;
      if (!userEmail || !plan || !amount) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const pendingLog = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: 'pending',
        description: `${plan} Subscription - Payment Pending`,
        amount: amount,
        currency: 'AUD',
        status: 'pending',
        date: new Date(),
        createdAt: new Date(),
        metadata: {
          plan: plan,
          addedBy: 'stripe_checkout',
        },
      };
      await subscriptionStorage.insertOne(pendingLog);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price: process.env.STRIPE_PRICE_ID_BEST_MATES,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${req.headers.origin}/success?session_id={CHECKOUT_SESSION_ID}&userEmail=${userEmail}&plan=${plan}&amount=${amount}&payment_status=paid`,
        cancel_url: `${req.headers.origin}/cancel?session_id={CHECKOUT_SESSION_ID}&userEmail=${userEmail}&plan=${plan}&amount=${amount}&payment_status=cancelled`,
        customer_email: userEmail,
        metadata: {
          userEmail: userEmail,
          plan: plan,
          amount: amount.toString(),
        },
      });
      res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create checkout session' });
    }
  });

  // Get user subscription details
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
      const [totalSessions, totalMessages, toolsInShed] = await Promise.all([
        sessionsStorage
          ? (async () => {
              const sessionQuery = {
                $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
              };
              const count = await sessionsStorage.countDocuments(sessionQuery);
              return count;
            })()
          : 0,
        messagesStorage
          ? (async () => {
              const messageQuery = {
                $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
              };
              const count = await messagesStorage.countDocuments(messageQuery);
              return count;
            })()
          : 0,
        shedToolsStorage
          ? (async () => {
              const userIdToQuery = user.clerkId || userEmail;
              const shedQuery = {
                user_id: userIdToQuery,
                collection: { $ne: 'shed_analytics' },
              };
              const count = await shedToolsStorage.countDocuments(shedQuery);
              const tools = await shedToolsStorage.find(shedQuery).limit(5).toArray();
              if (count === 0 && user.clerkId) {
                const emailQuery = {
                  user_id: userEmail,
                  collection: { $ne: 'shed_analytics' },
                };
                const emailCount = await shedToolsStorage.countDocuments(emailQuery);
                if (emailCount > 0) {
                  return emailCount;
                }
              }
              return count;
            })()
          : 0,
      ]);
      let lastActivity = user.updatedAt;
      try {
        const lastSession = await sessionsStorage.findOne(
          {
            $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
          },
          { sort: { timestamp: -1 } }
        );
        if (lastSession && lastSession.timestamp) {
          lastActivity = lastSession.timestamp;
        }
      } catch (error) {
        console.log(error);
      }
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
          isActive: user.isSubscribed || false,
          status: user.isSubscribed ? 'active' : 'inactive',
          plan: user.isSubscribed ? 'premium' : 'free',
          startDate: user.createdAt || null,
          endDate: null,
          customerId: null,
          subscriptionId: null,
        },
        usage: {
          totalSessions,
          totalMessages,
          toolsInShed,
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
      const formattedLogs = purchaseLogs.map((log) => ({
        id: log._id.toString(),
        type: log.type || log.action || 'transaction',
        description: log.description || log.title || 'Transaction',
        amount: log.amount || 0,
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
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }

      if (!type || !description) {
        return res.status(400).json({ error: 'Type and description are required' });
      }
      const duplicateCheckCriteria = {
        userEmail,
        type,
        description,
        status,
      };
      if (metadata?.stripeSessionId) {
        duplicateCheckCriteria['metadata.stripeSessionId'] = metadata.stripeSessionId;
      }
      const existingLog = await subscriptionStorage.findOne(duplicateCheckCriteria);

      if (existingLog) {
        return res.status(200).json({
          success: true,
          message: 'Purchase already logged',
          logId: existingLog._id.toString(),
          duplicate: true,
        });
      }

      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      let reactivationData = null;
      const GRACE_PERIOD_DAYS = 30;

      if (type === 'purchase' && status === 'completed') {
        const lastCancellation = await subscriptionStorage.findOne(
          {
            userEmail: userEmail,
            type: 'cancellation',
          },
          { sort: { createdAt: -1 } }
        );

        const isWithinGracePeriod =
          lastCancellation && differenceInDays(new Date(), lastCancellation.createdAt) <= GRACE_PERIOD_DAYS;

        if (isWithinGracePeriod) {
          await usersStorage.updateOne(
            { userEmail },
            {
              $set: {
                isSubscribed: true,
                subscriptionReactivatedAt: new Date(),
                updatedAt: new Date(),
                subscriptionCancelReason: null,
                subscriptionCancelFeedback: null,
              },
            }
          );
          reactivationData = {
            userEmail: userEmail,
            userId: user.clerkId || userEmail,
            clerkId: user.clerkId,
            userName: user.userName,
            type: 'reactivation',
            description: 'Subscription reactivated within grace period',
            amount: amount || 29.99,
            currency: currency || 'AUD',
            status: 'completed',
            date: new Date(),
            createdAt: new Date(),
            metadata: {
              ...metadata,
              previousCancellationId: lastCancellation._id.toString(),
              gracePeriodDays: GRACE_PERIOD_DAYS,
              reactivationTrigger: 'automatic',
              ...userInfo,
              addedBy: 'system',
            },
          };
          const reactivationResult = await subscriptionStorage.insertOne(reactivationData);
          reactivationData._id = reactivationResult.insertedId;
          await auditLogger.logAudit({
            action: 'AUTO_REACTIVATE_SUBSCRIPTION',
            resource: 'subscription',
            resourceId: user._id.toString(),
            userId: user._id.toString(),
            userEmail: userEmail,
            role: user.role || 'user',
            oldData: {
              isSubscribed: false,
              subscriptionCancelledAt: user.subscriptionCancelledAt,
              subscriptionCancelReason: user.subscriptionCancelReason,
            },
            newData: {
              isSubscribed: true,
              subscriptionReactivatedAt: new Date(),
              updatedAt: new Date(),
            },
            metadata: {
              reason: 'Purchase within grace period of cancellation',
              cancellationDate: lastCancellation.createdAt,
              gracePeriodDays: GRACE_PERIOD_DAYS,
              ...userInfo,
            },
          });
        }
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
          requestId: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          ...(reactivationData ? { relatedReactivationId: reactivationData._id.toString() } : {}),
        },
      };
      const finalDuplicateCheck = await subscriptionStorage.findOne(duplicateCheckCriteria);
      if (finalDuplicateCheck) {
        return res.status(200).json({
          success: true,
          message: 'Purchase already logged (race condition prevented)',
          logId: finalDuplicateCheck._id.toString(),
          duplicate: true,
        });
      }
      const result = await subscriptionStorage.insertOne(logEntry);
      if (type === 'purchase' && status === 'completed' && !reactivationData) {
        await usersStorage.updateOne(
          { userEmail },
          {
            $set: {
              isSubscribed: true,
              updatedAt: new Date(),
            },
          }
        );
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
          ...(reactivationData ? { isReactivation: true } : {}),
        },
      });
      const response = {
        success: true,
        message: 'Purchase log added successfully',
        logId: result.insertedId,
        log: {
          ...logEntry,
          id: result.insertedId.toString(),
        },
        duplicate: false,
      };
      if (reactivationData) {
        response.reactivation = {
          id: reactivationData._id.toString(),
          message: 'Subscription automatically reactivated within grace period',
          gracePeriodDays: GRACE_PERIOD_DAYS,
          previousCancellationId: reactivationData.metadata.previousCancellationId,
        };
      }
      res.json(response);
    } catch (error) {
      console.error('Error in purchase-logs endpoint:', error);
      res.status(500).json({
        error: 'Failed to add purchase log',
        details: error.message,
      });
    }
  });

  router.post('/api/subscription/:userEmail/cancel', async (req, res) => {
    try {
      const { userEmail } = req.params;
      const { reason, feedback } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      if (!user.isSubscribed) {
        return res.status(400).json({ error: 'No active subscription to cancel' });
      }
      // Update user subscription status
      const updateData = {
        isSubscribed: false,
        subscriptionCancelledAt: new Date(),
        subscriptionCancelReason: reason || 'User requested cancellation',
        subscriptionCancelFeedback: feedback || null,
        updatedAt: new Date(),
      };
      await usersStorage.updateOne({ userEmail }, { $set: updateData });
      // Add cancellation log to subscriptionStorage
      const cancellationLog = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: 'cancellation',
        description: 'Subscription cancelled',
        amount: 0,
        currency: 'AUD',
        status: 'completed',
        date: new Date(),
        createdAt: new Date(),
        reason: reason || 'User requested cancellation',
        feedback: feedback || null,
        metadata: {
          ...userInfo,
          previousPlan: user.isSubscribed ? 'premium' : 'free',
        },
      };
      await subscriptionStorage.insertOne(cancellationLog);
      // Log audit trail
      await auditLogger.logAudit({
        action: 'CANCEL_SUBSCRIPTION',
        resource: 'subscription',
        resourceId: user._id.toString(),
        userId: user._id.toString(),
        userEmail: userEmail,
        role: user.role || 'user',
        oldData: {
          isSubscribed: user.isSubscribed,
        },
        newData: updateData,
        metadata: {
          reason: reason,
          feedback: feedback,
          ...userInfo,
        },
      });
      res.json({
        success: true,
        message: 'Subscription cancelled successfully',
        cancellationDate: new Date(),
        refundEligible: false,
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to cancel subscription' });
    }
  });

  router.post('/api/subscription/:userEmail/reactivate', async (req, res) => {
    try {
      const { userEmail } = req.params;
      const userInfo = getUserInfoFromRequest(req);
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.isSubscribed) {
        return res.status(400).json({ error: 'Subscription is already active' });
      }
      // Update user subscription status
      const updateData = {
        isSubscribed: true,
        subscriptionReactivatedAt: new Date(),
        updatedAt: new Date(),
      };
      await usersStorage.updateOne({ userEmail }, { $set: updateData });
      const reactivationLog = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: 'reactivation',
        description: 'Subscription reactivated',
        amount: 10,
        currency: 'AUD',
        status: 'completed',
        date: new Date(),
        createdAt: new Date(),
        metadata: {
          ...userInfo,
          newPlan: 'premium',
        },
      };
      await subscriptionStorage.insertOne(reactivationLog);
      // Log audit trail
      await auditLogger.logAudit({
        action: 'REACTIVATE_SUBSCRIPTION',
        resource: 'subscription',
        resourceId: user._id.toString(),
        userId: user._id.toString(),
        userEmail: userEmail,
        role: user.role || 'user',
        oldData: {
          isSubscribed: user.isSubscribed,
        },
        newData: updateData,
        metadata: userInfo,
      });

      res.json({
        success: true,
        message: 'Subscription reactivated successfully',
        reactivationDate: new Date(),
      });
    } catch (error) {
      res.status(500).json({ error: 'Failed to reactivate subscription' });
    }
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
      const [sessionStats, messageStats, shedStats] = await Promise.all([
        sessionsStorage
          ? sessionsStorage
              .aggregate([
                {
                  $match: {
                    $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
                  },
                },
                {
                  $group: {
                    _id: null,
                    totalSessions: { $sum: 1 },
                    flaggedSessions: { $sum: { $cond: ['$flagTriggered', 1, 0] } },
                    budgetTiers: { $push: '$budgetTier' },
                    lastSession: { $max: '$timestamp' },
                  },
                },
              ])
              .toArray()
          : [{ totalSessions: 0, flaggedSessions: 0, budgetTiers: [], lastSession: null }],
        messagesStorage
          ? messagesStorage
              .aggregate([
                {
                  $match: {
                    $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
                  },
                },
                {
                  $project: {
                    messageCount: { $size: { $ifNull: ['$messages', []] } },
                  },
                },
                {
                  $group: {
                    _id: null,
                    totalMessages: { $sum: '$messageCount' },
                    totalConversations: { $sum: 1 },
                  },
                },
              ])
              .toArray()
          : [{ totalMessages: 0, totalConversations: 0 }],
        shedToolsStorage
          ? shedToolsStorage
              .aggregate([
                {
                  $match: {
                    user_id: user.clerkId || userEmail,
                    collection: { $ne: 'shed_analytics' },
                  },
                },
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
      const sessionData = sessionStats[0] || {
        totalSessions: 0,
        flaggedSessions: 0,
        budgetTiers: [],
        lastSession: null,
      };
      const messageData = messageStats[0] || { totalMessages: 0, totalConversations: 0 };
      const budgetTierCounts = sessionData.budgetTiers.reduce((acc, tier) => {
        acc[tier] = (acc[tier] || 0) + 1;
        return acc;
      }, {});

      res.json({
        sessions: {
          total: sessionData.totalSessions,
          flagged: sessionData.flaggedSessions,
          lastActivity: sessionData.lastSession,
          budgetTierDistribution: budgetTierCounts,
        },
        messages: {
          total: messageData.totalMessages,
          conversations: messageData.totalConversations,
          averagePerConversation:
            messageData.totalConversations > 0
              ? Math.round((messageData.totalMessages / messageData.totalConversations) * 100) / 100
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
        usersStorage.countDocuments({ isSubscribed: true }),
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
        query.isSubscribed = true;
      } else if (status === 'inactive') {
        query.isSubscribed = { $ne: true };
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
          const [sessionCount, messageCount, toolCount, lastSession] = await Promise.all([
            sessionsStorage
              ? sessionsStorage.countDocuments({
                  $or: [{ userEmail: user.userEmail }, { userEmail: { $in: [user.userEmail] } }],
                })
              : 0,
            messagesStorage
              ? messagesStorage.countDocuments({
                  $or: [{ userEmail: user.userEmail }, { userEmail: { $in: [user.userEmail] } }],
                })
              : 0,
            shedToolsStorage
              ? shedToolsStorage.countDocuments({
                  user_id: user.clerkId || user.userEmail,
                  collection: { $ne: 'shed_analytics' },
                })
              : 0,
            sessionsStorage
              ? sessionsStorage.findOne(
                  {
                    $or: [{ userEmail: user.userEmail }, { userEmail: { $in: [user.userEmail] } }],
                  },
                  { sort: { timestamp: -1 } }
                )
              : null,
          ]);
          return {
            id: user._id,
            userName: user.userName || 'Best Mates Subscription',
            userEmail: user.userEmail,
            userImage: user.userImage,
            isSubscribed: user.isSubscribed || false,
            role: user.role || 'user',
            isBanned: user.isBanned || false,
            createdAt: user.createdAt,
            lastActivity: lastSession?.timestamp || user.updatedAt,
            usage: {
              sessions: sessionCount,
              messages: messageCount,
              tools: toolCount,
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
      const activeSubscriptions = await usersStorage.find({ isSubscribed: true }).toArray();
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
        usersStorage.countDocuments({ isSubscribed: true }),
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
      const activeSubscriptions = await usersStorage.countDocuments({ isSubscribed: true });
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
      if (user.isSubscribed && user.createdAt <= monthEnd) {
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
