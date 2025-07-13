const express = require("express")
const { ObjectId } = require("mongodb")
module.exports = ({ emailLogsStorage, emailService, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()
  router.get("/admin/email-logs", async (req, res) => {
    try {
      const { page = 1, limit = 50, type, success, recipient } = req.query
      const skip = (page - 1) * limit
      const query = {}
      if (type) query.type = type
      if (success !== undefined) query.success = success === "true"
      if (recipient) query.recipient = { $regex: recipient, $options: "i" }
      const logs = await emailLogsStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()
      const total = await emailLogsStorage.countDocuments(query)
      const stats = await emailLogsStorage
        .aggregate([
          {
            $group: {
              _id: {
                type: "$type",
                success: "$success",
              },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray()
      res.json({
        logs,
        stats: stats.reduce((acc, stat) => {
          const key = `${stat._id.type}_${stat._id.success ? "success" : "failed"}`
          acc[key] = stat.count
          return acc
        }, {}),
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching email logs:", error)
      res.status(500).json({ error: "Failed to fetch email logs" })
    }
  })
  router.get("/admin/email-stats", async (req, res) => {
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
      const totalEmails = await emailLogsStorage.countDocuments({
        timestamp: { $gte: startDate },
      })
      const successfulEmails = await emailLogsStorage.countDocuments({
        timestamp: { $gte: startDate },
        success: true,
      })
      const failedEmails = await emailLogsStorage.countDocuments({
        timestamp: { $gte: startDate },
        success: false,
      })
      const emailsByType = await emailLogsStorage
        .aggregate([
          { $match: { timestamp: { $gte: startDate } } },
          {
            $group: {
              _id: "$type",
              count: { $sum: 1 },
              successful: {
                $sum: { $cond: ["$success", 1, 0] },
              },
            },
          },
        ])
        .toArray()
      res.json({
        period,
        dateRange: { start: startDate, end: now },
        summary: {
          totalEmails,
          successfulEmails,
          failedEmails,
          successRate: totalEmails > 0 ? ((successfulEmails / totalEmails) * 100).toFixed(2) : 0,
        },
        emailsByType,
      })
    } catch (error) {
      console.error("Error fetching email statistics:", error)
      res.status(500).json({ error: "Failed to fetch email statistics" })
    }
  })
  router.post("/admin/email-logs/:id/resend", async (req, res) => {
    try {
      const { id } = req.params
      const userInfo = getUserInfoFromRequest(req)
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid email log ID format" })
      }
      const emailLog = await emailLogsStorage.findOne({ _id: new ObjectId(id) })
      if (!emailLog) {
        return res.status(404).json({ error: "Email log not found" })
      }
      if (emailLog.success) {
        return res.status(400).json({ error: "Cannot resend successful email" })
      }

      // Resend based on email type
      let result
      switch (emailLog.type) {
        case "welcome":
          result = await emailService.sendWelcomeEmail(emailLog.recipient, emailLog.recipientName)
          break
        case "password_reset_success":
          result = await emailService.sendPasswordResetSuccessEmail(emailLog.recipient, emailLog.recipientName)
          break
        case "system_alert":
          result = await emailService.sendSystemAlertEmail(
            emailLog.recipient,
            emailLog.recipientName,
            emailLog.subType,
            emailLog.message,
          )
          break
        default:
          return res.status(400).json({ error: "Unknown email type for resend" })
      }

      // Log audit for email resend
      await auditLogger.logAudit({
        action: "RESEND_EMAIL",
        resource: "email",
        resourceId: id,
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        newData: {
          originalEmailId: id,
          resendResult: result,
          recipient: emailLog.recipient,
          emailType: emailLog.type,
        },
        metadata: {
          adminAction: true,
          originalEmailFailed: true,
        },
        ...userInfo,
      })

      res.json({
        message: "Email resend attempted",
        success: result.success,
        originalLogId: id,
      })
    } catch (error) {
      console.error("Error resending email:", error)
      res.status(500).json({ error: "Failed to resend email" })
    }
  })

  return router
}
