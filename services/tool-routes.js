const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({ toolsStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()

  router.post("/store-suggested-tools", async (req, res) => {
    try {
      const data = req.body
      const userInfo = getUserInfoFromRequest(req)
      const emailArray = data.userEmail
      const existingUser = await toolsStorage.findOne({
        userEmail: { $elemMatch: { $in: emailArray } },
        userName: data.userName,
      })
      if (existingUser) {
        const oldData = { suggestedTools: existingUser.suggestedTools }
        const result = await toolsStorage.updateOne(
          { _id: existingUser._id },
          {
            $set: {
              suggestedTools: data.suggestedTools,
            },
          },
        )
        // Log audit for tools update
        await auditLogger.logAudit({
          action: "UPDATE",
          resource: "suggested_tools",
          resourceId: existingUser._id.toString(),
          userId: data.userEmail?.[0] || data.userEmail,
          userEmail: data.userEmail?.[0] || data.userEmail,
          role: "user",
          oldData,
          newData: { suggestedTools: data.suggestedTools },
          ...userInfo,
        })

        res.send({ updated: true, result })
      } else {
        const result = await toolsStorage.insertOne(data)
        // Log audit for tools creation
        await auditLogger.logAudit({
          action: "CREATE",
          resource: "suggested_tools",
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
      console.error("Error storing suggested tools:", error)
      res.status(500).send({ error: "Internal server error" })
    }
  })

  router.get("/tools/:email", async (req, res) => {
    try {
      const email = req.params.email
      const query = { userEmail: email }
      const result = await toolsStorage.find(query).toArray()
      res.send(result)
    } catch (error) {
      res.status(500).send(error)
    }
  })

  return router
}
