const express = require("express")
const router = express.Router()

module.exports = (dependencies) => {
  const { chatLogsStorage, usersStorage, auditLogger, ObjectId, getUserInfoFromRequest } = dependencies
  router.get("/job-logs/:userEmail", async (req, res) => {
    try {
      const { userEmail } = req.params
      const { page = 1, limit = 100 } = req.query
      const query = {
        userEmail: userEmail,
      }
      const logs = await chatLogsStorage.find(query).sort({ timestamp: -1 }).toArray()
      const total = await chatLogsStorage.countDocuments(query)
      const sessionGroups = {}
      const sessionIds = [...new Set(logs.map((log) => log.sessionId))]
      const sessionWithTimestamps = sessionIds.map((sessionId) => {
        const sessionLogs = logs.filter((log) => log.sessionId === sessionId)
        const earliestTimestamp = Math.min(...sessionLogs.map((log) => new Date(log.timestamp).getTime()))
        return { sessionId, earliestTimestamp }
      })
      sessionWithTimestamps.sort((a, b) => a.earliestTimestamp - b.earliestTimestamp)
      sessionWithTimestamps.forEach((session, index) => {
        const sessionKey = `session_${index + 1}`
        sessionGroups[sessionKey] = logs.filter((log) => log.sessionId === session.sessionId)
      })
      const userInfo = getUserInfoFromRequest(req)
      await auditLogger.logAudit({
        action: "VIEW_JOB_LOGS",
        resource: "job_log",
        resourceEmail: userEmail,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        metadata: {
          page: Number.parseInt(page),
          limit: Number.parseInt(limit),
          totalLogsFetched: logs.length,
          sessionsCount: sessionIds.length,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      })
      res.send({
        success: true,
        ...sessionGroups,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
        },
      })
    } catch (error) {
      console.error("Error fetching user job logs:", error)
      res.status(500).send({ success: false, error: "Failed to fetch job logs" })
    }
  })
  router.get("/admin/job-logs", async (req, res) => {
    try {
      const { page = 1, limit = 20, search, userId, dateFrom, dateTo, lightweight } = req.query
      const skip = (page - 1) * limit
      const userInfo = getUserInfoFromRequest(req)
      const query = {}
      if (search) {
        query.$or = [
          { userName: { $regex: search, $options: "i" } },
          { userEmail: { $regex: search, $options: "i" } },
          { prompt: { $regex: search, $options: "i" } },
          { mateyResponse: { $regex: search, $options: "i" } },
        ]
      }

      if (userId) {
        query.$or = [{ userEmail: userId }, { userEmail: { $in: [userId] } }]
      }
      if (dateFrom || dateTo) {
        query.timestamp = {}
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom)
        if (dateTo) query.timestamp.$lte = new Date(dateTo)
      }
      let projection = {}
      if (lightweight === "true") {
        projection = {
          _id: 1,
          sessionId: 1,
          userName: 1,
          userEmail: 1,
          timestamp: 1,
          "metadata.notes": 1,
        }
      }
      const logs = await chatLogsStorage
        .find(query, { projection })
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
      await auditLogger.logAudit({
        action: "ADMIN_VIEW_JOB_LOGS",
        resource: "job_log",
        resourceId: "all",
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        metadata: {
          page: Number.parseInt(page),
          limit: Number.parseInt(limit),
          searchQuery: search,
          filterUserId: userId,
          totalLogsFetched: enrichedLogs.length,
          lightweight: lightweight === "true",
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      })
      res.json({
        jobLogs: enrichedLogs,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching admin job logs:", error)
      res.status(500).json({ error: "Failed to fetch admin job logs" })
    }
  })

  router.get("/admin/job-logs/enhanced", async (req, res) => {
    try {
      const { page = 1, limit = 20, search, userId, dateFrom, dateTo } = req.query
      const skip = (page - 1) * limit
      const userInfo = getUserInfoFromRequest(req)

      const query = {}
      if (search) {
        query.$or = [
          { userName: { $regex: search, $options: "i" } },
          { userEmail: { $regex: search, $options: "i" } },
          { prompt: { $regex: search, $options: "i" } },
          { mateyResponse: { $regex: search, $options: "i" } },
        ]
      }

      if (userId) {
        query.$or = [{ userEmail: userId }, { userEmail: { $in: [userId] } }]
      }

      if (dateFrom || dateTo) {
        query.timestamp = {}
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom)
        if (dateTo) query.timestamp.$lte = new Date(dateTo)
      }
      const projection = {
        _id: 1,
        sessionId: 1,
        userName: 1,
        userEmail: 1,
        timestamp: 1,
        "metadata.notes": 1,
      }

      const logs = await chatLogsStorage
        .find(query, { projection })
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()
      const total = await chatLogsStorage.countDocuments(query)
      const enhancedLogs = logs.map((log) => ({
        ...log,
        sessionId: log.sessionId,
        timestamp: log.timestamp,
        notes: log.metadata?.notes || null,
      }))
      await auditLogger.logAudit({
        action: "ADMIN_VIEW_JOB_LOGS_ENHANCED",
        resource: "job_log",
        resourceId: "all",
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        metadata: {
          page: Number.parseInt(page),
          limit: Number.parseInt(limit),
          searchQuery: search,
          filterUserId: userId,
          totalLogsFetched: enhancedLogs.length,
          enhanced: true,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      })

      res.json({
        jobLogs: enhancedLogs,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching enhanced admin job logs:", error)
      res.status(500).json({ error: "Failed to fetch enhanced admin job logs" })
    }
  })
  router.get("/admin/job-logs/:id/details", async (req, res) => {
    try {
      const { id } = req.params
      const userInfo = getUserInfoFromRequest(req)
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid job log ID format" })
      }
      const log = await chatLogsStorage.findOne({ _id: new ObjectId(id) })
      if (!log) {
        return res.status(404).json({ error: "Job log not found" })
      }
      const user = await usersStorage.findOne({
        userEmail: { $in: Array.isArray(log.userEmail) ? log.userEmail : [log.userEmail] },
      })
      const enrichedLog = {
        ...log,
        userDetails: user || null,
      }
      await auditLogger.logAudit({
        action: "VIEW_JOB_LOG_DETAILS",
        resource: "job_log",
        resourceId: id,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        metadata: {
          targetSessionId: log.sessionId,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      })

      res.json(enrichedLog)
    } catch (error) {
      console.error("Error fetching job log details:", error)
      res.status(500).json({ error: "Failed to fetch job log details" })
    }
  })
  router.put("/admin/job-logs/:id/notes", async (req, res) => {
    try {
      const { id } = req.params
      const { notes } = req.body
      const userInfo = getUserInfoFromRequest(req)
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid job log ID format" })
      }
      const existingLog = await chatLogsStorage.findOne({ _id: new ObjectId(id) })
      if (!existingLog) {
        return res.status(404).json({ error: "Job log not found" })
      }
      const updateData = {
        "metadata.notes": notes,
        updatedAt: new Date(),
      }
      const result = await chatLogsStorage.updateOne({ _id: new ObjectId(id) }, { $set: updateData })
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Job log not found or not updated" })
      }
      await auditLogger.logAudit({
        action: "UPDATE_JOB_LOG_NOTES",
        resource: "job_log",
        resourceId: id,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        oldData: { notes: existingLog.metadata?.notes },
        newData: { notes: notes },
        metadata: {
          targetSessionId: existingLog.sessionId,
          adminAction: true,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      })
      res.json({ success: true, message: "Job log notes updated successfully" })
    } catch (error) {
      console.error("Error updating job log notes:", error)
      res.status(500).json({ error: "Failed to update job log notes" })
    }
  })
  router.delete("/admin/job-logs/:id", async (req, res) => {
    try {
      const { id } = req.params
      const userInfo = getUserInfoFromRequest(req)
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid job log ID format" })
      }
      const existingLog = await chatLogsStorage.findOne({ _id: new ObjectId(id) })
      if (!existingLog) {
        return res.status(404).json({ error: "Job log not found" })
      }
      const result = await chatLogsStorage.deleteOne({ _id: new ObjectId(id) })
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Job log not found or not deleted" })
      }
      await auditLogger.logAudit({
        action: "DELETE_JOB_LOG",
        resource: "job_log",
        resourceId: id,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        oldData: existingLog,
        metadata: {
          targetSessionId: existingLog.sessionId,
          adminAction: true,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      })
      res.json({ success: true, message: "Job log deleted successfully" })
    } catch (error) {
      console.error("Error deleting job log:", error)
      res.status(500).json({ error: "Failed to delete job log" })
    }
  })

  return router
}
