const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({ messagesStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()

  router.post("/store-messages", async (req, res) => {
    try {
      const data = req.body
      const userInfo = getUserInfoFromRequest(req)
      const emailArray = Array.isArray(data.userEmail) ? data.userEmail : [data.userEmail]
      const existingUserMessages = await messagesStorage.findOne({
        userEmail: { $elemMatch: { $in: emailArray } },
        userName: data.userName,
      })

      let result
      if (existingUserMessages) {
        const oldData = { messages: existingUserMessages.messages }
        result = await messagesStorage.updateOne(
          { _id: existingUserMessages._id },
          { $set: { messages: data.messages } },
        )

        // Log audit for message update
        await auditLogger.logAudit({
          action: "UPDATE",
          resource: "messages",
          resourceId: existingUserMessages._id.toString(),
          userId: data.userEmail?.[0] || data.userEmail,
          userEmail: data.userEmail?.[0] || data.userEmail,
          role: "user",
          oldData,
          newData: { messages: data.messages },
          ...userInfo,
        })

        res.send({ updated: true, result })
      } else {
        result = await messagesStorage.insertOne(data)

        // Log audit for message creation
        await auditLogger.logAudit({
          action: "CREATE",
          resource: "messages",
          resourceId: result.insertedId.toString(),
          userId: data.userEmail?.[0] || data.userEmail,
          userEmail: data.userEmail?.[0] || data.userEmail,
          role: "user",
          newData: data,
          ...userInfo,
        })

        res.send({ inserted: true, result })
      }
    } catch (error) {
      console.error("Error storing messages:", error)
      res.status(500).send({ error: "Internal server error" })
    }
  })

  router.get("/messages/:email", async (req, res) => {
    try {
      const email = req.params.email
      const query = { userEmail: email }
      const result = await messagesStorage.find(query).toArray()
      res.send(result)
    } catch (error) {
      res.status(500).send(error)
    }
  })

  return router
}
