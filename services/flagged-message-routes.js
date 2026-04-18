const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({ flaggedMessagesStorage, sessionsStorage, usersStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()

  router.get("/admin/flagged-messages/lightweight", async (req, res) => {
    try {
      const { status, page = 1, limit = 20, search } = req.query
      const skip = (page - 1) * limit
      const query = {
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
      }
      if (status && status !== "all") {
        query.status = status.toLowerCase()
      }
      if (search && search.trim() !== "") {
        query.messageText = {
          $regex: search.trim(),
          $options: "i",
        }
      }
      const flaggedMessages = await flaggedMessagesStorage
        .find(query, {
          projection: {
            _id: 1,
            userEmail: 1,
            status: 1,
            flaggedAt: 1,
            messageText: 1,
          },
        })
        .sort({ flaggedAt: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()
      const total = await flaggedMessagesStorage.countDocuments(query)
      res.json({
        flaggedMessages,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching lightweight flagged messages:", error)
      res.status(500).json({
        error: "Failed to fetch lightweight flagged messages",
        details: error.message,
      })
    }
  })
  router.get("/admin/flagged-messages/:id/details", async (req, res) => {
    try {
      const { id } = req.params
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid message ID format" })
      }
      const messageDetails = await flaggedMessagesStorage.findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            reasons: 1,
            otherReason: 1,
            messageTimestamp: 1,
            adminComments: 1,
            reviewedBy: 1,
            reviewedAt: 1,
            isLoggedInUser: 1,
          },
        },
      )
      if (!messageDetails) {
        return res.status(404).json({ error: "Message not found" })
      }
      res.json(messageDetails)
    } catch (error) {
      console.error("Error fetching message details:", error)
      res.status(500).json({
        error: "Failed to fetch message details",
        details: error.message,
      })
    }
  })
  router.get("/admin/flagged-messages", async (req, res) => {
    try {
      const { status, page = 1, limit = 20, search } = req.query
      const skip = (page - 1) * limit
      const query = {
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
      }
      if (status && status !== "all") {
        query.status = status.toLowerCase()
      }
      if (search && search.trim() !== "") {
        query.messageText = {
          $regex: search.trim(),
          $options: "i",
        }
      }
      const flaggedMessages = await flaggedMessagesStorage
        .find(query)
        .sort({ flaggedAt: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()
      const total = await flaggedMessagesStorage.countDocuments(query)
      res.json({
        flaggedMessages,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching flagged messages:", error)
      res.status(500).json({
        error: "Failed to fetch flagged messages",
        details: error.message,
      })
    }
  })

  router.post("/admin/cleanup-expired-messages", async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req)
      const now = new Date()
      const result = await flaggedMessagesStorage.deleteMany({
        expiresAt: { $lt: now },
      })
      // Log audit for cleanup action
      await auditLogger.logAudit({
        action: "CLEANUP",
        resource: "flagged_messages",
        resourceId: null,
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        newData: {
          deletedCount: result.deletedCount,
          cleanupDate: now,
        },
        metadata: {
          adminAction: true,
          automatedCleanup: true,
        },
        ...userInfo,
      })

      res.json({
        message: `Cleaned up ${result.deletedCount} expired messages`,
        deletedCount: result.deletedCount,
      })
    } catch (error) {
      console.error("Error cleaning up expired messages:", error)
      res.status(500).json({ error: "Failed to cleanup expired messages" })
    }
  })

  router.put("/admin/flagged-messages/:id", async (req, res) => {
    try {
      const { id } = req.params
      const { status, adminComments, reviewedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid message ID format" })
      }
      const currentMessage = await flaggedMessagesStorage.findOne({ _id: new ObjectId(id) })
      if (!currentMessage) {
        return res.status(404).json({ error: "Flagged message not found" })
      }
      const validTransitions = {
        pending: ["approved", "rejected"],
        approved: ["resolved"],
        rejected: [],
        resolved: [],
      }
      const allowedTransitions = validTransitions[currentMessage.status] || []
      if (!allowedTransitions.includes(status)) {
        return res.status(400).json({
          error: `Invalid status transition from ${currentMessage.status} to ${status}`,
        })
      }
      if (status === "approved" && (!adminComments || !adminComments.trim())) {
        return res.status(400).json({
          error: "Admin comment is required when approving a message",
        })
      }
      const updateData = {
        status: status.toLowerCase(),
        adminComments,
        reviewedAt: new Date(),
        reviewedBy: reviewedBy || "admin",
      }
      if (status === "rejected") {
        updateData.softDeleted = true
        updateData.softDeletedAt = new Date()
        const expiryDate = new Date()
        expiryDate.setDate(expiryDate.getDate() + 60)
        updateData.expiresAt = expiryDate
      }
      if (status === "resolved") {
        updateData.archived = true
        updateData.archivedAt = new Date()
        const expiryDate = new Date()
        expiryDate.setDate(expiryDate.getDate() + 60)
        updateData.expiresAt = expiryDate
      }
      const result = await flaggedMessagesStorage.updateOne({ _id: new ObjectId(id) }, { $set: updateData })
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Flagged message not found" })
      }

      // Log audit for flagged message status update
      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "flagged_message",
        resourceId: id,
        userId: reviewedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: currentMessage,
        newData: updateData,
        metadata: {
          statusTransition: `${currentMessage.status} -> ${status}`,
          adminAction: true,
        },
        ...userInfo,
      })

      res.json({ message: "Flagged message updated successfully" })
    } catch (error) {
      console.error("Error updating flagged message:", error)
      res.status(500).json({ error: "Failed to update flagged message" })
    }
  })

  router.get("/admin/flagged-messages/:id/context", async (req, res) => {
    try {
      const { id } = req.params
      const flaggedMessage = await flaggedMessagesStorage.findOne({ _id: new ObjectId(id) })
      if (!flaggedMessage) {
        return res.status(404).json({ error: "Flagged message not found" })
      }
      let session = null
      let user = null
      if (flaggedMessage.userEmail) {
        const userEmailToSearch = Array.isArray(flaggedMessage.userEmail)
          ? flaggedMessage.userEmail[0]
          : flaggedMessage.userEmail
        session = await sessionsStorage.findOne({
          $or: [
            { userEmail: userEmailToSearch },
            {
              userEmail: {
                $in: Array.isArray(flaggedMessage.userEmail) ? flaggedMessage.userEmail : [flaggedMessage.userEmail],
              },
            },
          ],
          "messages.id": flaggedMessage.messageId,
        })
        user = await usersStorage.findOne({
          $or: [
            { userEmail: userEmailToSearch },
            {
              userEmail: {
                $in: Array.isArray(flaggedMessage.userEmail) ? flaggedMessage.userEmail : [flaggedMessage.userEmail],
              },
            },
          ],
        })
      } else {
        session = await sessionsStorage.findOne({
          "messages.id": flaggedMessage.messageId,
        })
        user = null
      }
      res.json({
        flaggedMessage,
        sessionContext: session || null,
        userDetails: user || null,
      })
    } catch (error) {
      console.error("Error fetching session context:", error)
      res.status(500).json({ error: "Failed to fetch session context" })
    }
  })

  router.delete("/admin/flagged-messages/:id", async (req, res) => {
    try {
      const { id } = req.params
      const userInfo = getUserInfoFromRequest(req)
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: "Invalid message ID format" })
      }
      // Get the message before deletion for audit log
      const flaggedMessage = await flaggedMessagesStorage.findOne({ _id: new ObjectId(id) })
      if (!flaggedMessage) {
        return res.status(404).json({ error: "Flagged message not found" })
      }

      const result = await flaggedMessagesStorage.deleteOne({ _id: new ObjectId(id) })
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: "Flagged message not found" })
      }
      // Log audit for flagged message deletion
      await auditLogger.logAudit({
        action: "DELETE",
        resource: "flagged_message",
        resourceId: id,
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: flaggedMessage,
        metadata: {
          adminAction: true,
        },
        ...userInfo,
      })

      res.json({ message: "Flagged message deleted successfully" })
    } catch (error) {
      console.error("Error deleting flagged message:", error)
      res.status(500).json({
        error: "Failed to delete flagged message",
      })
    }
  })

  return router
}
