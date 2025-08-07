const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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
        // Silent error handling
      }
      const subscriptionData = {
        user: {
          id: user._id,
          userName: user.userName || 'Unknown User',
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
      if (type === 'purchase') {
        await usersStorage.updateOne({ userEmail }, { $set: { isSubscribed: true } });
      }
      // Log audit trail
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
        amount: 29.99,
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
      const { period = '30d' } = req.query;
      let dateFilter = {};
      const now = new Date();
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
        case '90d':
          dateFilter = { createdAt: { $gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) } };
          break;
        case '1y':
          dateFilter = { createdAt: { $gte: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000) } };
          break;
        case 'all':
        default:
          dateFilter = {};
          break;
      }
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
      let previousPeriodFilter = {};
      switch (period) {
        case '24h':
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(now.getTime() - 48 * 60 * 60 * 1000),
              $lt: new Date(now.getTime() - 24 * 60 * 60 * 1000),
            },
          };
          break;
        case '7d':
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
              $lt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
            },
          };
          break;
        case '30d':
          previousPeriodFilter = {
            createdAt: {
              $gte: new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000),
              $lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
            },
          };
          break;
      }
      let growthMetrics = {};
      if (period !== 'all' && period !== '90d' && period !== '1y') {
        const [previousUsers, previousRevenue, previousSubscriptions] = await Promise.all([
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
        ]);
        const prevRevenueAmount = previousRevenue[0]?.total || 0;
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
        };
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
            userName: user.userName || 'Unknown',
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
      const { period = '30d', breakdown = 'daily' } = req.query;
      let dateFilter = {};
      const now = new Date();
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
        case '90d':
          dateFilter = { createdAt: { $gte: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) } };
          break;
        case '1y':
          dateFilter = { createdAt: { $gte: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000) } };
          break;
        case 'all':
        default:
          dateFilter = {};
          break;
      }
      let groupBy = {};
      if (period === '24h') {
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
      } else if (breakdown === 'weekly' || period === '90d' || period === '1y') {
        groupBy = {
          year: { $year: '$createdAt' },
          week: { $week: '$createdAt' },
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
          plan: type._id || 'Unknown',
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
      switch (period) {
        case '24h':
          dateFilter = { timestamp: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } };
          break;
        case '7d':
          dateFilter = { timestamp: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } };
          break;
        case '30d':
          dateFilter = { timestamp: { $gte: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } };
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
        // Message activty
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
  return router;
};
