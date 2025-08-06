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
      } catch (clerkError) {
        // Silent error handling
      }
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

  return router;
};
