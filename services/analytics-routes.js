const express = require("express")
const { ObjectId } = require("mongodb")
module.exports = ({ flaggedMessagesStorage, toolsStorage, sessionsStorage, usersStorage }) => {
  const router = express.Router()
  router.get("/admin/analytics", async (req, res) => {
    try {
      const { period = "7d" } = req.query
      const now = new Date()
      const startDate = new Date()
      switch (period) {
        case "24h":
          startDate.setHours(startDate.getHours() - 24)
          break
        case "7d":
          startDate.setDate(startDate.getDate() - 7)
          break
        case "30d":
          startDate.setDate(startDate.getDate() - 30)
          break
        default:
          startDate.setDate(startDate.getDate() - 7)
      }
      const mostFlaggedTools = await flaggedMessagesStorage
        .aggregate([
          { $match: { flaggedAt: { $gte: startDate } } },
          {
            $lookup: {
              from: "Sessions",
              localField: "messageId",
              foreignField: "messages.id",
              as: "session",
            },
          },
          { $unwind: { path: "$session", preserveNullAndEmptyArrays: true } },
          { $unwind: { path: "$session.suggestedTools", preserveNullAndEmptyArrays: true } },
          { $group: { _id: "$session.suggestedTools.name", flagCount: { $sum: 1 } } },
          { $sort: { flagCount: -1 } },
          { $limit: 10 },
        ])
        .toArray()
      const flagsByReason = await flaggedMessagesStorage
        .aggregate([
          { $match: { flaggedAt: { $gte: startDate } } },
          { $unwind: "$reasons" },
          { $group: { _id: "$reasons", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
        ])
        .toArray()
      const allToolsWithFlags = await flaggedMessagesStorage.distinct("messageId")
      const toolsWithNoFlags = await toolsStorage
        .aggregate([
          { $match: { "suggestedTools.id": { $nin: allToolsWithFlags } } },
          { $unwind: "$suggestedTools" },
          { $group: { _id: "$suggestedTools.products.name", count: { $sum: 1 } } },
        ])
        .toArray()
      const totalSessions = await sessionsStorage.countDocuments({ timestamp: { $gte: startDate } })
      const totalFlags = await flaggedMessagesStorage.countDocuments({ flaggedAt: { $gte: startDate } })
      const totalRedirects = await sessionsStorage.countDocuments({ timestamp: { $gte: startDate } })
      const totalUsers = await usersStorage.countDocuments({ createdAt: { $gte: startDate } })
      const subscribedUsers = await usersStorage.countDocuments({ isSubscribed: true, createdAt: { $gte: startDate } })
      res.json({
        period,
        dateRange: { start: startDate, end: now },
        statistics: { totalSessions, totalFlags, totalRedirects, totalUsers, subscribedUsers },
        mostFlaggedTools,
        flagsByReason,
        toolsWithNoFlags: toolsWithNoFlags.slice(0, 10),
      })
    } catch (error) {
      console.error("Error fetching analytics:", error)
      res.status(500).json({ error: "Failed to fetch analytics" })
    }
  })

  return router
}
