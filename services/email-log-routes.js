const express = require("express")
const { ObjectId } = require("mongodb")
const { getAdminActorFromRequest } = require("./admin-actor")

const ALLOWED_ADMIN_ROLES = new Set(["owner", "admin", "support"])

module.exports = ({ emailLogsStorage, emailService, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()

  const getAdminActor = (req) => getAdminActorFromRequest(req)

  const requireAdminAccess = (req, res) => {
    const actor = getAdminActor(req)
    if (!ALLOWED_ADMIN_ROLES.has(actor.role)) {
      res.status(403).json({
        error: "Admin access required for email operations",
        details: "Missing or invalid admin role header",
      })
      return null
    }
    return actor
  }

  const buildResendHandler = async (emailLog) => {
    const attemptNumber = Number(emailLog.attemptNumber || 1) + 1

    switch (emailLog.emailType || emailLog.type) {
      case "welcome":
        return emailService.deliverEmail({
          msg: {
            to: emailLog.recipient,
            from: { email: process.env.FROM_EMAIL || "noreply@toolmate.com", name: process.env.FROM_NAME || "Toolmate" },
            subject: emailLog.subject || "Welcome to Toolmate!",
            text: null,
            html: emailLog.content || null,
          },
          emailType: "welcome",
          recipient: emailLog.recipient,
          recipientName: emailLog.recipientName,
          subject: emailLog.subject || "Welcome to Toolmate!",
          metadata: emailLog.metadata || {},
          triggerSource: "email_log_resend",
          resourceType: "email",
          resourceId: emailLog._id.toString(),
          requestedBy: "admin_resend",
          attemptNumber,
          resentFromLogId: emailLog._id.toString(),
        })
      case "password_reset_success":
      case "name_changed":
      case "email_changed":
      case "password_changed":
      case "user_banned":
      case "user_unbanned":
      case "role_changed":
      case "subscription_gifted":
      case "system_alert":
        return emailService.deliverEmail({
          msg: {
            to: emailLog.recipient,
            from: { email: process.env.FROM_EMAIL || "noreply@toolmate.com", name: process.env.FROM_NAME || "Toolmate" },
            subject: emailLog.subject || "Toolmate Email",
            text: emailLog.message || null,
            html: emailLog.content || null,
          },
          emailType: emailLog.emailType || emailLog.type,
          subType: emailLog.subType || null,
          recipient: emailLog.recipient,
          recipientName: emailLog.recipientName,
          subject: emailLog.subject || "Toolmate Email",
          message: emailLog.message || null,
          metadata: emailLog.metadata || {},
          triggerSource: "email_log_resend",
          resourceType: "email",
          resourceId: emailLog._id.toString(),
          requestedBy: "admin_resend",
          attemptNumber,
          resentFromLogId: emailLog._id.toString(),
        })
      default:
        return null
    }
  }

  router.get("/admin/email-logs", async (req, res) => {
    const actor = requireAdminAccess(req, res)
    if (!actor) return

    try {
      const {
        page = 1,
        limit = 50,
        type,
        success,
        recipient,
        failureCategory,
        triggerSource,
        provider,
        retryable,
      } = req.query

      const skip = (Number(page) - 1) * Number(limit)
      const query = {}

      if (type) query.type = type
      if (success !== undefined) query.success = success === "true"
      if (recipient) query.recipient = { $regex: recipient, $options: "i" }
      if (failureCategory) query.failureCategory = failureCategory
      if (triggerSource) query.triggerSource = triggerSource
      if (provider) query.provider = provider
      if (retryable !== undefined) query.retryable = retryable === "true"

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
                status: "$status",
                failureCategory: "$failureCategory",
              },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray()

      res.json({
        logs,
        stats: stats.reduce((acc, stat) => {
          const typeKey = stat._id.type || "unknown"
          const statusKey = stat._id.status || "unknown"
          acc[`${typeKey}_${statusKey}`] = (acc[`${typeKey}_${statusKey}`] || 0) + stat.count
          if (stat._id.failureCategory) {
            acc[`failure_${stat._id.failureCategory}`] = (acc[`failure_${stat._id.failureCategory}`] || 0) + stat.count
          }
          return acc
        }, {}),
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / Number(limit)),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching email logs:", error)
      res.status(500).json({
        error: "Failed to fetch email logs",
        details: error.message || String(error),
      })
    }
  })

  router.get("/admin/email-stats", async (req, res) => {
    const actor = requireAdminAccess(req, res)
    if (!actor) return

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
              successful: { $sum: { $cond: ["$success", 1, 0] } },
              retryableFailures: {
                $sum: {
                  $cond: [{ $and: [{ $eq: ["$success", false] }, { $eq: ["$retryable", true] }] }, 1, 0],
                },
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
          successRate: totalEmails > 0 ? ((successfulEmails / totalEmails) * 100).toFixed(2) : "0.00",
        },
        emailsByType,
      })
    } catch (error) {
      console.error("Error fetching email statistics:", error)
      res.status(500).json({
        error: "Failed to fetch email statistics",
        details: error.message || String(error),
      })
    }
  })

  router.post("/admin/email-logs/:id/resend", async (req, res) => {
    const actor = requireAdminAccess(req, res)
    if (!actor) return

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

      const emailResult = await buildResendHandler(emailLog)
      if (!emailResult) {
        return res.status(400).json({
          error: "Unknown or non-resendable email type",
          emailType: emailLog.emailType || emailLog.type,
        })
      }

      await auditLogger.logAudit({
        action: emailResult.success ? "RESEND_EMAIL" : "RESEND_EMAIL_FAILED",
        resource: "email",
        resourceId: id,
        userId: actor.userEmail,
        userEmail: actor.userEmail,
        role: actor.role,
        newData: {
          originalEmailId: id,
          resendResult: emailResult,
          recipient: emailLog.recipient,
          emailType: emailLog.emailType || emailLog.type,
          resendLogId: emailResult.logId,
        },
        metadata: {
          adminAction: true,
          originalEmailFailed: true,
          requestedBy: actor.username,
        },
        ...userInfo,
      })

      const statusCode = emailResult.success ? 200 : 502
      res.status(statusCode).json({
        success: emailResult.success,
        message: emailResult.success ? "Email resent successfully" : "Email resend failed",
        originalLogId: id,
        resendLogId: emailResult.logId,
        email: emailResult,
      })
    } catch (error) {
      console.error("Error resending email:", error)
      res.status(500).json({
        error: "Failed to resend email",
        details: error.message || String(error),
      })
    }
  })

  return router
}
