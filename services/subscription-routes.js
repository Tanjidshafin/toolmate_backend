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
  } = dependencies
  const router = express.Router()
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
          ? sessionsStorage.countDocuments({
              $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
            })
          : 0,
        messagesStorage
          ? messagesStorage.countDocuments({
              $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
            })
          : 0,
        shedToolsStorage
          ? shedToolsStorage.countDocuments({
              user_id: userEmail,
              collection: { $ne: "shed_analytics" },
            })
          : 0,
      ])
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
      res.json(subscriptionData)
    } catch (error) {
      console.error("Error fetching subscription details:", error)
      res.status(500).json({ error: "Failed to fetch subscription details" })
    }
  })
  // Get purchase logs for user
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
      const purchaseLogs = []
      if (user.isSubscribed) {
        purchaseLogs.push({
          id: new ObjectId().toString(),
          type: "purchase",
          description: "Best Mate Premium Subscription",
          amount: 29.99,
          currency: "AUD",
          status: "completed",
          date: user.createdAt || new Date(),
        })
      }
      if (user.createdAt) {
        purchaseLogs.push({
          id: new ObjectId().toString(),
          type: "account_created",
          description: "Account created",
          amount: 0,
          currency: "AUD",
          status: "completed",
          date: user.createdAt,
        })
      }
      if (user.isBanned && user.bannedAt) {
        purchaseLogs.push({
          id: new ObjectId().toString(),
          type: "suspension",
          description: "Account suspended",
          amount: 0,
          currency: "AUD",
          status: "completed",
          date: user.bannedAt,
        })
      }
      try {
        if (shedToolsStorage) {
          const shedActivities = await shedToolsStorage
            .find({
              collection: "shed_analytics",
              user_id: userEmail,
              action: { $in: ["shed_cleared", "bulk_import"] },
            })
            .sort({ timestamp: -1 })
            .limit(5)
            .toArray()
          shedActivities.forEach((activity) => {
            purchaseLogs.push({
              id: new ObjectId().toString(),
              type: activity.action,
              description:
                activity.action === "shed_cleared"
                  ? `Shed cleared (${activity.tools_count || 0} tools removed)`
                  : `Bulk import (${activity.tools_count || 0} tools added)`,
              amount: 0,
              currency: "AUD",
              status: "completed",
              date: activity.timestamp,
            })
          })
        }
      } catch (error) {
        console.warn("Could not fetch shed analytics:", error.message)
      }
      const sortedLogs = purchaseLogs.sort((a, b) => new Date(b.date) - new Date(a.date))
      const startIndex = (page - 1) * limit
      const endIndex = startIndex + Number.parseInt(limit)
      const paginatedLogs = sortedLogs.slice(startIndex, endIndex)
      res.json({
        purchaseLogs: paginatedLogs,
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(sortedLogs.length / limit),
          totalLogs: sortedLogs.length,
          hasNext: endIndex < sortedLogs.length,
          hasPrev: startIndex > 0,
        },
      })
    } catch (error) {
      console.error("Error fetching purchase logs:", error)
      res.status(500).json({ error: "Failed to fetch purchase logs" })
    }
  })
  // Cancel subscription
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
  // Reactivate subscription
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
  router.get("/api/subscription/:userEmail/usage-details", async (req, res) => {
    try {
      const { userEmail } = req.params

      if (!userEmail) {
        return res.status(400).json({ error: "User email is required" })
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
        // Shed statistics
        shedToolsStorage
          ? shedToolsStorage
              .aggregate([
                {
                  $match: {
                    user_id: userEmail,
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

  return router
}
