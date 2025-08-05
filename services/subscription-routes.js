const express = require("express")

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
  } = dependencies
  const router = express.Router()
  // Get user subscription details
  router.get("/api/subscription/:userEmail", async (req, res) => {
    try {
      const { userEmail } = req.params
      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
      }
      const user = await usersStorage.findOne({ userEmail })
      if (!user) {
        return res.status(404).json({ error: "User not found" })
      }
      let clerkUser = null
      try {
        if (user.clerkId) {
          clerkUser = await clerkClient.users.getUser(user.clerkId)
        }
      } catch (clerkError) {
        console.warn("Could not fetch Clerk user data:", clerkError.message)
      }
      const [totalSessions, totalMessages, toolsInShed] = await Promise.all([
        sessionsStorage
          ? (async () => {
              const sessionQuery = {
                $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
              }
              console.log("Session query:", JSON.stringify(sessionQuery)) 
              const count = await sessionsStorage.countDocuments(sessionQuery)
              console.log("Sessions found:", count) 
              return count
            })()
          : 0,

        // Count messages - userEmail can be string or array
        messagesStorage
          ? (async () => {
              const messageQuery = {
                $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
              }
              console.log("Message query:", JSON.stringify(messageQuery)) // Debug log
              const count = await messagesStorage.countDocuments(messageQuery)
              console.log("Messages found:", count) // Debug log
              return count
            })()
          : 0,

        // Count shed tools - uses user_id field with Clerk user ID
        shedToolsStorage
          ? (async () => {
              // Use Clerk user ID for shed tools, not email
              const userIdToQuery = user.clerkId || userEmail
              const shedQuery = {
                user_id: userIdToQuery,
                collection: { $ne: "shed_analytics" }, // Exclude analytics entries
              }
              console.log("Shed query:", JSON.stringify(shedQuery)) // Debug log
              const count = await shedToolsStorage.countDocuments(shedQuery)
              console.log("Shed tools found:", count) // Debug log

              // Also check what tools exist for debugging
              const tools = await shedToolsStorage.find(shedQuery).limit(5).toArray()
              console.log(
                "Sample shed tools:",
                tools.map((t) => ({ name: t.tool_name, user_id: t.user_id, collection: t.collection })),
              ) // Debug log

              // Also check if there are any tools with email as user_id (fallback)
              if (count === 0 && user.clerkId) {
                const emailQuery = {
                  user_id: userEmail,
                  collection: { $ne: "shed_analytics" },
                }
                console.log("Trying email fallback query:", JSON.stringify(emailQuery)) // Debug log
                const emailCount = await shedToolsStorage.countDocuments(emailQuery)
                console.log("Shed tools found with email:", emailCount) // Debug log
                if (emailCount > 0) {
                  return emailCount
                }
              }

              return count
            })()
          : 0,
      ])

      console.log("Final usage stats:", { totalSessions, totalMessages, toolsInShed }) // Debug log

      // Get last activity from sessions
      let lastActivity = user.updatedAt
      try {
        const lastSession = await sessionsStorage.findOne(
          {
            $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
          },
          { sort: { timestamp: -1 } },
        )
        if (lastSession && lastSession.timestamp) {
          lastActivity = lastSession.timestamp
        }
      } catch (error) {
        console.warn("Could not fetch last session:", error.message)
      }

      // Prepare subscription data based on actual schema
      const subscriptionData = {
        user: {
          id: user._id,
          userName: user.userName || "Unknown User",
          userEmail: user.userEmail,
          userImage: user.userImage || null,
          createdAt: user.createdAt || null,
          lastSignInAt: clerkUser?.lastSignInAt || null,
          role: user.role || "user",
          isBanned: user.isBanned || false,
        },
        subscription: {
          isActive: user.isSubscribed || false,
          status: user.isSubscribed ? "active" : "inactive",
          plan: user.isSubscribed ? "premium" : "free",
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
      }

      console.log("Returning subscription data:", subscriptionData) // Debug log
      res.json(subscriptionData)
    } catch (error) {
      console.error("Error fetching subscription details:", error)
      res.status(500).json({ error: "Failed to fetch subscription details" })
    }
  })

  // Get purchase logs for user (based on real data)
  router.get("/api/subscription/:userEmail/purchase-logs", async (req, res) => {
    try {
      const { userEmail } = req.params
      const { page = 1, limit = 10 } = req.query

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
      }

      const user = await usersStorage.findOne({ userEmail })

      if (!user) {
        return res.status(404).json({ error: "User not found" })
      }

      // Fetch real purchase logs from subscriptionStorage
      const userIdToQuery = user.clerkId || userEmail

      const purchaseLogsQuery = {
        $or: [{ userEmail: userEmail }, { userId: userIdToQuery }, { clerkId: user.clerkId }],
      }

      const totalLogs = await subscriptionStorage.countDocuments(purchaseLogsQuery)

      const purchaseLogs = await subscriptionStorage
        .find(purchaseLogsQuery)
        .sort({ date: -1, createdAt: -1, timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(Number.parseInt(limit))
        .toArray()

      // Transform the logs to match expected format
      const formattedLogs = purchaseLogs.map((log) => ({
        id: log._id.toString(),
        type: log.type || log.action || "transaction",
        description: log.description || log.title || "Transaction",
        amount: log.amount || 0,
        currency: log.currency || "AUD",
        status: log.status || "completed",
        date: log.date || log.createdAt || log.timestamp || new Date(),
        reason: log.reason || null,
        feedback: log.feedback || null,
        metadata: log.metadata || {},
      }))

      res.json({
        purchaseLogs: formattedLogs,
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(totalLogs / limit),
          totalLogs: totalLogs,
          hasNext: page * limit < totalLogs,
          hasPrev: page > 1,
        },
      })
    } catch (error) {
      console.error("Error fetching purchase logs:", error)
      res.status(500).json({ error: "Failed to fetch purchase logs" })
    }
  })

  // POST API to add purchase logs to subscriptionStorage
  router.post("/api/subscription/:userEmail/purchase-logs", async (req, res) => {
    try {
      const { userEmail } = req.params
      const { type, description, amount, currency, status, reason, feedback, metadata } = req.body
      const userInfo = getUserInfoFromRequest(req)

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
      }

      if (!type || !description) {
        return res.status(400).json({ error: "Type and description are required" })
      }

      const user = await usersStorage.findOne({ userEmail })

      if (!user) {
        return res.status(404).json({ error: "User not found" })
      }

      // Create new purchase log entry
      const logEntry = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: type,
        description: description,
        amount: amount || 0,
        currency: currency || "AUD",
        status: status || "completed",
        date: new Date(),
        createdAt: new Date(),
        reason: reason || null,
        feedback: feedback || null,
        metadata: {
          ...metadata,
          ...userInfo,
          addedBy: "system",
        },
      }

      const result = await subscriptionStorage.insertOne(logEntry)

      // Log audit trail
      await auditLogger.logAudit({
        action: "CREATE_PURCHASE_LOG",
        resource: "subscription_log",
        resourceId: result.insertedId.toString(),
        userId: user._id.toString(),
        userEmail: userEmail,
        role: user.role || "user",
        newData: logEntry,
        metadata: {
          logType: type,
          ...userInfo,
        },
      })

      res.json({
        success: true,
        message: "Purchase log added successfully",
        logId: result.insertedId,
        log: {
          ...logEntry,
          id: result.insertedId.toString(),
        },
      })
    } catch (error) {
      console.error("Error adding purchase log:", error)
      res.status(500).json({ error: "Failed to add purchase log" })
    }
  })

  // Cancel subscription (update isSubscribed to false and add log)
  router.post("/api/subscription/:userEmail/cancel", async (req, res) => {
    try {
      const { userEmail } = req.params
      const { reason, feedback } = req.body
      const userInfo = getUserInfoFromRequest(req)

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
      }

      const user = await usersStorage.findOne({ userEmail })
      if (!user) {
        return res.status(404).json({ error: "User not found" })
      }

      if (!user.isSubscribed) {
        return res.status(400).json({ error: "No active subscription to cancel" })
      }

      // Update user subscription status
      const updateData = {
        isSubscribed: false,
        subscriptionCancelledAt: new Date(),
        subscriptionCancelReason: reason || "User requested cancellation",
        subscriptionCancelFeedback: feedback || null,
        updatedAt: new Date(),
      }

      await usersStorage.updateOne({ userEmail }, { $set: updateData })

      // Add cancellation log to subscriptionStorage
      const cancellationLog = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: "cancellation",
        description: "Subscription cancelled",
        amount: 0,
        currency: "AUD",
        status: "completed",
        date: new Date(),
        createdAt: new Date(),
        reason: reason || "User requested cancellation",
        feedback: feedback || null,
        metadata: {
          ...userInfo,
          previousPlan: user.isSubscribed ? "premium" : "free",
        },
      }

      await subscriptionStorage.insertOne(cancellationLog)

      // Log audit trail
      await auditLogger.logAudit({
        action: "CANCEL_SUBSCRIPTION",
        resource: "subscription",
        resourceId: user._id.toString(),
        userId: user._id.toString(),
        userEmail: userEmail,
        role: user.role || "user",
        oldData: {
          isSubscribed: user.isSubscribed,
        },
        newData: updateData,
        metadata: {
          reason: reason,
          feedback: feedback,
          ...userInfo,
        },
      })

      res.json({
        success: true,
        message: "Subscription cancelled successfully",
        cancellationDate: new Date(),
        refundEligible: false,
      })
    } catch (error) {
      console.error("Error cancelling subscription:", error)
      res.status(500).json({ error: "Failed to cancel subscription" })
    }
  })

  // Reactivate subscription (update isSubscribed to true and add log)
  router.post("/api/subscription/:userEmail/reactivate", async (req, res) => {
    try {
      const { userEmail } = req.params
      const userInfo = getUserInfoFromRequest(req)

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
      }

      const user = await usersStorage.findOne({ userEmail })
      if (!user) {
        return res.status(404).json({ error: "User not found" })
      }

      if (user.isSubscribed) {
        return res.status(400).json({ error: "Subscription is already active" })
      }

      // Update user subscription status
      const updateData = {
        isSubscribed: true,
        subscriptionReactivatedAt: new Date(),
        updatedAt: new Date(),
      }

      await usersStorage.updateOne({ userEmail }, { $set: updateData })

      // Add reactivation log to subscriptionStorage
      const reactivationLog = {
        userEmail: userEmail,
        userId: user.clerkId || userEmail,
        clerkId: user.clerkId,
        userName: user.userName,
        type: "reactivation",
        description: "Subscription reactivated",
        amount: 29.99,
        currency: "AUD",
        status: "completed",
        date: new Date(),
        createdAt: new Date(),
        metadata: {
          ...userInfo,
          newPlan: "premium",
        },
      }

      await subscriptionStorage.insertOne(reactivationLog)

      // Log audit trail
      await auditLogger.logAudit({
        action: "REACTIVATE_SUBSCRIPTION",
        resource: "subscription",
        resourceId: user._id.toString(),
        userId: user._id.toString(),
        userEmail: userEmail,
        role: user.role || "user",
        oldData: {
          isSubscribed: user.isSubscribed,
        },
        newData: updateData,
        metadata: userInfo,
      })

      res.json({
        success: true,
        message: "Subscription reactivated successfully",
        reactivationDate: new Date(),
      })
    } catch (error) {
      console.error("Error reactivating subscription:", error)
      res.status(500).json({ error: "Failed to reactivate subscription" })
    }
  })

  // Get detailed usage breakdown
  router.get("/api/subscription/:userEmail/usage-details", async (req, res) => {
    try {
      const { userEmail } = req.params

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
      }

      const user = await usersStorage.findOne({ userEmail })
      if (!user) {
        return res.status(404).json({ error: "User not found" })
      }

      // Get detailed usage statistics
      const [sessionStats, messageStats, shedStats] = await Promise.all([
        // Session statistics
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
                    flaggedSessions: { $sum: { $cond: ["$flagTriggered", 1, 0] } },
                    budgetTiers: { $push: "$budgetTier" },
                    lastSession: { $max: "$timestamp" },
                  },
                },
              ])
              .toArray()
          : [{ totalSessions: 0, flaggedSessions: 0, budgetTiers: [], lastSession: null }],

        // Message statistics
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
                    messageCount: { $size: { $ifNull: ["$messages", []] } },
                  },
                },
                {
                  $group: {
                    _id: null,
                    totalMessages: { $sum: "$messageCount" },
                    totalConversations: { $sum: 1 },
                  },
                },
              ])
              .toArray()
          : [{ totalMessages: 0, totalConversations: 0 }],

        // Shed statistics using Clerk user ID
        shedToolsStorage
          ? shedToolsStorage
              .aggregate([
                {
                  $match: {
                    user_id: user.clerkId || userEmail,
                    collection: { $ne: "shed_analytics" },
                  },
                },
                {
                  $group: {
                    _id: "$category",
                    count: { $sum: 1 },
                    tools: { $push: "$tool_name" },
                  },
                },
              ])
              .toArray()
          : [],
      ])

      const sessionData = sessionStats[0] || {
        totalSessions: 0,
        flaggedSessions: 0,
        budgetTiers: [],
        lastSession: null,
      }
      const messageData = messageStats[0] || { totalMessages: 0, totalConversations: 0 }

      // Process budget tier distribution
      const budgetTierCounts = sessionData.budgetTiers.reduce((acc, tier) => {
        acc[tier] = (acc[tier] || 0) + 1
        return acc
      }, {})

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
            name: cat._id || "Other",
            count: cat.count,
            tools: cat.tools,
          })),
        },
      })
    } catch (error) {
      console.error("Error fetching usage details:", error)
      res.status(500).json({ error: "Failed to fetch usage details" })
    }
  })

  // Bulk create initial purchase logs for existing users
  router.post("/api/subscription/admin/seed-purchase-logs", async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req)

      // Get all users
      const users = await usersStorage.find({}).toArray()
      let logsCreated = 0

      for (const user of users) {
        const userIdToQuery = user.clerkId || user.userEmail

        // Check if user already has logs
        const existingLogs = await subscriptionStorage.countDocuments({
          $or: [{ userEmail: user.userEmail }, { userId: userIdToQuery }, { clerkId: user.clerkId }],
        })

        if (existingLogs === 0) {
          const logsToCreate = []

          // Account creation log
          if (user.createdAt) {
            logsToCreate.push({
              userEmail: user.userEmail,
              userId: userIdToQuery,
              clerkId: user.clerkId,
              userName: user.userName,
              type: "account_created",
              description: "Account created",
              amount: 0,
              currency: "AUD",
              status: "completed",
              date: user.createdAt,
              createdAt: new Date(),
              metadata: {
                ...userInfo,
                seeded: true,
              },
            })
          }

          // Subscription purchase if subscribed
          if (user.isSubscribed) {
            logsToCreate.push({
              userEmail: user.userEmail,
              userId: userIdToQuery,
              clerkId: user.clerkId,
              userName: user.userName,
              type: "purchase",
              description: "Best Mate Premium Subscription",
              amount: 29.99,
              currency: "AUD",
              status: "completed",
              date: user.createdAt || new Date(),
              createdAt: new Date(),
              metadata: {
                ...userInfo,
                seeded: true,
              },
            })
          }

          if (logsToCreate.length > 0) {
            await subscriptionStorage.insertMany(logsToCreate)
            logsCreated += logsToCreate.length
          }
        }
      }

      res.json({
        success: true,
        message: `Seeded ${logsCreated} purchase logs for existing users`,
        logsCreated: logsCreated,
      })
    } catch (error) {
      console.error("Error seeding purchase logs:", error)
      res.status(500).json({ error: "Failed to seed purchase logs" })
    }
  })

  return router
}
