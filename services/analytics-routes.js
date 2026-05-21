const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({
  flaggedMessagesStorage,
  toolsStorage,
  usersStorage,
  redirectTrackingStorage,
  mateyChatSessionsStorage,
  messagesJobStorage,
  draftTelemetryStorage,
}) => {
  const router = express.Router()
  const hasActiveSubscriptionStatus = (user) => {
    const status = typeof user?.subscription?.status === "string" ? user.subscription.status.trim().toLowerCase() : ""
    return status === "active"
  }

  const toObjectIdIfValid = (value) => {
    if (!value || typeof value !== "string" || !ObjectId.isValid(value)) return null
    return new ObjectId(value)
  }

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

      const flaggedMessages = await flaggedMessagesStorage
        .find({ flaggedAt: { $gte: startDate } }, { projection: { messageId: 1 } })
        .toArray()

      const flaggedMessageObjectIds = flaggedMessages
        .map((flagged) => toObjectIdIfValid(flagged.messageId))
        .filter(Boolean)
      const flaggedClientMessageIds = flaggedMessages
        .map((flagged) => (typeof flagged.messageId === "string" ? flagged.messageId.trim() : ""))
        .filter(Boolean)

      const flaggedToolRows =
        flaggedMessageObjectIds.length > 0 || flaggedClientMessageIds.length > 0
          ? await messagesJobStorage
              .find(
                {
                  role: "matey",
                  $or: [
                    ...(flaggedMessageObjectIds.length > 0 ? [{ _id: { $in: flaggedMessageObjectIds } }] : []),
                    ...(flaggedClientMessageIds.length > 0
                      ? [{ clientMessageId: { $in: flaggedClientMessageIds } }]
                      : []),
                  ],
                },
                { projection: { suggestedTools: 1 } },
              )
              .toArray()
          : []

      const flaggedToolCounts = new Map()
      flaggedToolRows.forEach((row) => {
        const suggestedTools = Array.isArray(row.suggestedTools) ? row.suggestedTools : []
        suggestedTools.forEach((tool) => {
          const name =
            (typeof tool?.name === "string" && tool.name.trim()) ||
            (typeof tool?.display_name === "string" && tool.display_name.trim()) ||
            (typeof tool?.product_name === "string" && tool.product_name.trim()) ||
            null
          if (!name) return
          flaggedToolCounts.set(name, (flaggedToolCounts.get(name) || 0) + 1)
        })
      })

      const mostFlaggedTools = Array.from(flaggedToolCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([toolName, flagCount]) => ({ _id: toolName, flagCount }))

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

      const totalSessions = await mateyChatSessionsStorage.countDocuments({
        messageCount: { $gt: 0 },
        lastMessageAt: { $gte: startDate },
      })
      const totalFlags = await flaggedMessagesStorage.countDocuments({ flaggedAt: { $gte: startDate } })
      const totalRedirects = await redirectTrackingStorage.countDocuments({ timestamp: { $gte: startDate } })
      const users = await usersStorage.find({ createdAt: { $gte: startDate } }).toArray()
      const totalUsers = users.length
      const subscribedUsers = users.filter(hasActiveSubscriptionStatus).length

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

  /** Best-effort client draft / funnel events (separate from admin dashboard aggregates). */
  router.post("/track-analytics", async (req, res) => {
    try {
      if (!draftTelemetryStorage) {
        return res.status(503).json({ ok: false, error: "telemetry store unavailable" })
      }
      const body = req.body || {}
      const eventType = typeof body.eventType === "string" ? body.eventType.trim() : ""
      if (!eventType) {
        return res.status(400).json({ ok: false, error: "eventType required" })
      }
      await draftTelemetryStorage.insertOne({
        eventType,
        userId: body.userId ?? null,
        userEmail: body.userEmail ?? null,
        sessionId: body.sessionId ?? null,
        placement: body.placement ?? null,
        shoppingListCount: body.shoppingListCount ?? null,
        chipText: body.chipText ?? null,
        item: body.item ?? null,
        action: body.action ?? null,
        createdAt: new Date(),
      })
      return res.status(204).end()
    } catch (error) {
      console.error("track-analytics:", error?.message || error)
      return res.status(500).json({ ok: false })
    }
  })

  return router
}
