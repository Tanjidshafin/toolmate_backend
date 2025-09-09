const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({
  feedbackStorage,
  flaggedMessagesStorage,
  auditLogger,
  getUserInfoFromRequest,
  chatLogsStorage,
}) => {
  const router = express.Router()
  router.post("/add-feedback", async (req, res) => {
    try {
      const data = req.body
      console.log("Received feedback data:", JSON.stringify(data, null, 2))
      if (!data.messageId || data.messageId === "") {
        console.log("Missing or empty messageId")
        return res.status(400).send({
          error: "Missing required field: messageId",
          received: data,
        })
      }
      if (!data.email) {
        console.log("Missing email")
        return res.status(400).send({
          error: "Missing required field: email",
        })
      }
      const userInfo = getUserInfoFromRequest(req)
      const feedbackData = {
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        flagTriggered: Boolean(data.reportStatus && data.feedback?.reasons),
      }
      console.log("Inserting feedback:", feedbackData)
      const feedbackInsertResult = await feedbackStorage.insertOne(feedbackData)
      console.log("Feedback inserted with ID:", feedbackInsertResult.insertedId)

      // Prepareaudit log data
      const userEmail = Array.isArray(data.email) ? data.email[0] : data.email
      const auditData = {
        action: "CREATE",
        resource: "feedback",
        resourceId: feedbackInsertResult.insertedId.toString(),
        userId: userEmail,
        userEmail: userEmail,
        role: data.isLoggedInUser ? "user" : "anonymous",
        newData: {
          messageId: data.messageId,
          reportStatus: data.reportStatus,
          feedback: data.feedback,
        },
        ...userInfo,
      }
      await auditLogger.logAudit(auditData)
      if (data.reportStatus && data.feedback?.reasons) {
        console.log("Creating flagged message for messageId:", data.messageId)

        const flaggedMessage = {
          messageId: data.messageId,
          messageText: data.messageText,
          messageTimestamp: new Date(data.messageTimestamp),
          reasons: data.feedback.reasons,
          otherReason: data.feedback.otherReason || "",
          userEmail: data.email,
          isLoggedInUser: data.isLoggedInUser,
          status: "pending",
          adminComments: "",
          flaggedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          softDeleted: false,
          archived: false,
        }

        console.log("Flagged message data:", flaggedMessage)
        const flaggedResult = await flaggedMessagesStorage.insertOne(flaggedMessage)
        console.log("Flagged message created with ID:", flaggedResult.insertedId)

        const chatLogUpdateQuery = {
          mateyResponse: data.messageText,
          userEmail: Array.isArray(data.email) ? { $in: data.email } : data.email,
        }
        console.log("Updating chat logs with query:", chatLogUpdateQuery)

        const chatLogUpdateResult = await chatLogsStorage.updateMany(chatLogUpdateQuery, {
          $set: {
            flagTriggered: true,
            updatedAt: new Date(),
          },
        })
        console.log("Chat logs update result:", chatLogUpdateResult)

        // Log audit for flagged message
        await auditLogger.logAudit({
          ...auditData,
          resource: "flagged_message",
          resourceId: flaggedResult.insertedId.toString(),
          newData: {
            messageId: data.messageId,
            reasons: data.feedback.reasons,
            status: "pending",
          },
        })
      } else {
        console.log(
          "No flagged message created - reportStatus:",
          data.reportStatus,
          "reasons:",
          data.feedback?.reasons,
        )
      }

      console.log("Feedback process completed successfully")
      res.status(200).send(feedbackInsertResult)
    } catch (err) {
      console.error("Error adding feedback:", err)
      res.status(500).send({
        error: "Failed to store feedback",
        details: err.message,
      })
    }
  })

  router.get("/get-feedback", async (req, res) => {
    try {
      const { page = 1, limit = 20, search = "" } = req.query

      // Query for feedback that is not a report (helpful/unhelpful only)
      const query = {
        reportStatus: { $ne: true }, // Not a report
        $or: [{ "feedback.helpful": { $exists: true } }, { "feedback.unhelpful": { $exists: true } }],
      }

      // Add search functionality if provided
      if (search && search.trim()) {
        query.$and = [
          query.$and || [],
          {
            $or: [
              { messageText: { $regex: search.trim(), $options: "i" } },
              { email: { $regex: search.trim(), $options: "i" } },
              { name: { $regex: search.trim(), $options: "i" } },
            ],
          },
        ]
      }

      console.log("Fetching feedback with query:", JSON.stringify(query, null, 2))

      const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit)

      // Get feedback data with pagination
      const feedbackData = await feedbackStorage
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()

      // Get total count for pagination
      const totalCount = await feedbackStorage.countDocuments(query)
      const totalPages = Math.ceil(totalCount / Number.parseInt(limit))

      console.log("Found", feedbackData.length, "feedback entries")

      res.status(200).send({
        feedback: feedbackData,
        pagination: {
          current: Number.parseInt(page),
          total: totalPages,
          count: totalCount,
          limit: Number.parseInt(limit),
        },
      })
    } catch (err) {
      console.error("Error fetching feedback:", err)
      res.status(500).send({
        error: "Failed to fetch feedback",
        details: err.message,
      })
    }
  })

  return router
}
