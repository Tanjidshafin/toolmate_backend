const express = require("express")
const { ObjectId } = require("mongodb")
module.exports = ({ auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()
  router.get("/admin/audit-logs", async (req, res) => {
    try {
      const {
        page = 1,
        limit = 50,
        action,
        resource,
        userId,
        userEmail,
        role,
        dateFrom,
        dateTo,
        resourceId,
      } = req.query

      const result = await auditLogger.getAuditLogs({
        page: Number.parseInt(page),
        limit: Number.parseInt(limit),
        action,
        resource,
        userId,
        userEmail,
        role,
        dateFrom,
        dateTo,
        resourceId,
      })

      res.json(result)
    } catch (error) {
      console.error("Error fetching audit logs:", error)
      res.status(500).json({ error: "Failed to fetch audit logs" })
    }
  })
  router.get("/admin/audit-stats", async (req, res) => {
    try {
      const { dateFrom, dateTo } = req.query
      const stats = await auditLogger.getAuditStats(dateFrom, dateTo)
      res.json(stats)
    } catch (error) {
      console.error("Error fetching audit statistics:", error)
      res.status(500).json({ error: "Failed to fetch audit statistics" })
    }
  })

  router.get("/admin/audit-logs/user/:userId", async (req, res) => {
    try {
      const { userId } = req.params
      const { limit = 20 } = req.query
      const activity = await auditLogger.getUserActivity(userId, Number.parseInt(limit))
      res.json({ activity })
    } catch (error) {
      console.error("Error fetching user activity:", error)
      res.status(500).json({ error: "Failed to fetch user activity" })
    }
  })

  router.get("/admin/audit-logs/resource/:resource/:resourceId", async (req, res) => {
    try {
      const { resource, resourceId } = req.params
      const { limit = 20 } = req.query
      const activity = await auditLogger.getResourceActivity(resource, resourceId, Number.parseInt(limit))
      res.json({ activity })
    } catch (error) {
      console.error("Error fetching resource activity:", error)
      res.status(500).json({ error: "Failed to fetch resource activity" })
    }
  })

  router.post("/admin/audit-logs/cleanup", async (req, res) => {
    try {
      const { daysToKeep = 365 } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const deletedCount = await auditLogger.cleanupOldLogs(Number.parseInt(daysToKeep))
      await auditLogger.logAudit({
        action: "CLEANUP",
        resource: "audit_logs",
        resourceId: null,
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        newData: {
          deletedCount,
          daysToKeep: Number.parseInt(daysToKeep),
          cleanupDate: new Date(),
        },
        metadata: {
          adminAction: true,
          maintenanceTask: true,
        },
        ...userInfo,
      })
      res.json({
        message: `Cleaned up ${deletedCount} old audit logs`,
        deletedCount,
      })
    } catch (error) {
      console.error("Error cleaning up audit logs:", error)
      res.status(500).json({ error: "Failed to cleanup audit logs" })
    }
  })
  return router
}
