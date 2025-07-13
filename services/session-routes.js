const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({
  sessionsStorage,
  chatLogsStorage,
  usersStorage,
  auditLogger,
  emitNewLiveMessage,
  notifyActiveSessionsChanged,
  getUserInfoFromRequest,
}) => {
  const router = express.Router()

  router.post("/store-session", async (req, res) => {
    try {
      const {
        sessionId,
        userName,
        userEmail,
        prompt,
        mateyResponse,
        suggestedTools = [],
        budgetTier,
        flagTriggered = false,
        messages = [],
      } = req.body

      const userInfo = getUserInfoFromRequest(req)
      const timestamp = new Date()

      const sessionData = {
        sessionId,
        userName,
        userEmail,
        prompt,
        mateyResponse,
        suggestedTools,
        budgetTier,
        timestamp,
        flagTriggered,
        messages,
      }

      const logData = {
        sessionId,
        userEmail,
        userName,
        prompt,
        mateyResponse,
        suggestedTools,
        budgetTier,
        timestamp,
        flagTriggered,
        metadata: {
          userAgent: req.headers["user-agent"],
          ip: req.ip,
        },
      }
      if (messages && messages.length > 0 && sessionId) {
        emitNewLiveMessage({
          sessionId,
          userName,
          userEmail,
          timestamp,
          messageText: mateyResponse,
          userPrompt: prompt,
        })
      }
      const [sessionInsert, logInsert] = await Promise.all([
        sessionsStorage.insertOne(sessionData),
        chatLogsStorage.insertOne(logData),
      ])

      // Log audit for session creation
      await auditLogger.logAudit({
        action: "CREATE",
        resource: "session",
        resourceId: sessionInsert.insertedId.toString(),
        userId: userEmail?.[0] || userEmail,
        userEmail: userEmail?.[0] || userEmail,
        role: "user",
        newData: {
          sessionId,
          userName,
          prompt,
          budgetTier,
          flagTriggered,
        },
        ...userInfo,
      })

      notifyActiveSessionsChanged()
      res.json({
        success: true,
        sessionId: sessionInsert.insertedId,
        logId: logInsert.insertedId,
      })
    } catch (error) {
      console.error("Error storing session:", error)
      res.status(500).json({ error: "Failed to store session" })
    }
  })

  router.get("/admin/chat-logs", async (req, res) => {
    try {
      const { page = 1, limit = 50, search, flaggedOnly } = req.query
      const skip = (page - 1) * limit

      const query = {}
      if (search) {
        query.$or = [
          { userName: { $regex: search, $options: "i" } },
          { prompt: { $regex: search, $options: "i" } },
          { mateyResponse: { $regex: search, $options: "i" } },
        ]
      }
      if (flaggedOnly === "true") {
        query.flagTriggered = true
      }
      const logs = await chatLogsStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()
      const total = await chatLogsStorage.countDocuments(query)
      const enrichedLogs = await Promise.all(
        logs.map(async (log) => {
          const user = await usersStorage.findOne({
            userEmail: { $in: Array.isArray(log.userEmail) ? log.userEmail : [log.userEmail] },
          })
          return {
            ...log,
            userDetails: user || null,
          }
        }),
      )

      res.json({
        logs: enrichedLogs,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching chat logs:", error)
      res.status(500).json({ error: "Failed to fetch chat logs" })
    }
  })

  router.get("/admin/sessions", async (req, res) => {
    try {
      const { page = 1, limit = 20, search } = req.query
      const skip = (page - 1) * limit
      const query = {}
      if (search) {
        query.$or = [{ userName: { $regex: search, $options: "i" } }, { prompt: { $regex: search, $options: "i" } }]
      }

      const sessions = await sessionsStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()
      const total = await sessionsStorage.countDocuments(query)
      const enrichedSessions = await Promise.all(
        sessions.map(async (session) => {
          const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail
          const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null
          return {
            ...session,
            userDetails: user || null,
          }
        }),
      )

      res.json({
        sessions: enrichedSessions,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching sessions:", error)
      res.status(500).json({ error: "Failed to fetch sessions" })
    }
  })

  router.get("/admin/sessions/:id", async (req, res) => {
    try {
      const { id } = req.params
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid session ID format" })
      }
      const session = await sessionsStorage.findOne({ _id: new ObjectId(id) })

      if (!session) {
        return res.status(404).json({ error: "Session not found" })
      }
      const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail
      const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null
      res.json({
        ...session,
        userDetails: user || null,
      })
    } catch (error) {
      console.error("Error fetching session:", error)
      res.status(500).json({ error: "Failed to fetch session" })
    }
  })

  router.get("/admin/active-sessions", async (req, res) => {
    try {
      const fiveMinutesAgo = new Date()
      fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5)
      const uniqueSessions = await chatLogsStorage
        .aggregate([
          {
            $match: {
              timestamp: { $gte: fiveMinutesAgo },
            },
          },
          {
            $addFields: {
              email: {
                $cond: {
                  if: { $isArray: "$userEmail" },
                  then: { $arrayElemAt: ["$userEmail", 0] },
                  else: "$userEmail",
                },
              },
              userAgent: "$metadata.userAgent",
              ip: "$metadata.ip",
            },
          },
          {
            $sort: { timestamp: -1 },
          },
          {
            $group: {
              _id: {
                email: "$email",
                userName: "$userName",
                userAgent: "$userAgent",
                ip: "$ip",
              },
              latestSession: { $first: "$$ROOT" },
            },
          },
          {
            $replaceRoot: { newRoot: "$latestSession" },
          },
        ])
        .toArray()
      const enrichedSessions = await Promise.all(
        uniqueSessions.map(async (session) => {
          const emailToQuery = session.userEmail?.[0] || session.userEmail
          const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null
          return {
            ...session,
            userDetails: user || null,
          }
        }),
      )
      res.json(enrichedSessions)
    } catch (error) {
      console.error("Error fetching active sessions:", error)
      res.status(500).json({ error: "Failed to fetch active sessions" })
    }
  })

  return router
}
