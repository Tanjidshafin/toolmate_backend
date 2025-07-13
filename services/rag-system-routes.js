const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({ ragSystemStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()

  router.get("/admin/rag-system", async (req, res) => {
    try {
      const ragSettings = await ragSystemStorage.find({}).toArray()
      res.json(ragSettings)
    } catch (error) {
      console.error("Error fetching RAG settings:", error)
      res.status(500).json({ error: "Failed to fetch RAG settings" })
    }
  })
  router.put("/admin/rag-system/tool/:id/visibility", async (req, res) => {
    try {
      const { id } = req.params
      const { hidden, updatedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const existingTool = await ragSystemStorage.findOne({ id })
      await ragSystemStorage.updateOne(
        { id },
        { $set: { id, hidden, updatedAt: new Date(), updatedBy: updatedBy || "admin" } },
        { upsert: true },
      )
      // Log audit for RAG tool visibility update
      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "rag_tool_visibility",
        resourceId: id,
        userId: updatedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: existingTool,
        newData: { hidden, updatedAt: new Date(), updatedBy: updatedBy || "admin" },
        metadata: {
          toolId: id,
          visibilityChange: hidden ? "hidden" : "visible",
          adminAction: true,
        },
        ...userInfo,
      })

      res.json({ success: true, message: "Tool visibility updated" })
    } catch (error) {
      console.error("Error updating tool visibility:", error)
      res.status(500).json({ error: "Failed to update tool visibility" })
    }
  })

  router.put("/admin/rag-system/tool/:id/boost", async (req, res) => {
    try {
      const { id } = req.params
      const { boosted, duration, updatedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const existingTool = await ragSystemStorage.findOne({ id })
      let boostExpiry = null
      if (boosted && duration) {
        boostExpiry = new Date()
        boostExpiry.setHours(boostExpiry.getHours() + duration)
      }
      await ragSystemStorage.updateOne(
        { id },
        { $set: { id, boosted, boostExpiry, updatedAt: new Date(), updatedBy: updatedBy || "admin" } },
        { upsert: true },
      )
      // Log audit for RAG tool boost update
      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "rag_tool_boost",
        resourceId: id,
        userId: updatedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: existingTool,
        newData: { boosted, boostExpiry, updatedAt: new Date(), updatedBy: updatedBy || "admin" },
        metadata: {
          toolId: id,
          boostStatus: boosted ? "boosted" : "unboosted",
          boostDuration: duration,
          adminAction: true,
        },
        ...userInfo,
      })
      res.json({ success: true, message: "Tool boost updated" })
    } catch (error) {
      console.error("Error updating tool boost:", error)
      res.status(500).json({ error: "Failed to update tool boost" })
    }
  })
  router.get("/rag-system/boosted-tools", async (req, res) => {
    try {
      const boostedTools = await ragSystemStorage
        .find({
          boosted: true,
          $or: [{ boostExpiry: null }, { boostExpiry: { $gt: new Date() } }],
        })
        .toArray()
      res.json(boostedTools)
    } catch (error) {
      console.error("Error fetching boosted tools:", error)
      res.status(500).json({ error: "Failed to fetch boosted tools" })
    }
  })
  router.get("/rag-system/hidden-tools", async (req, res) => {
    try {
      const hiddenTools = await ragSystemStorage.find({ hidden: true }).toArray()
      res.json(hiddenTools)
    } catch (error) {
      console.error("Error fetching hidden tools:", error)
      res.status(500).json({ error: "Failed to fetch hidden tools" })
    }
  })
  router.get("/rag-system/ordered-tools", async (req, res) => {
    try {
      const now = new Date()
      const tools = await ragSystemStorage.find({ hidden: { $ne: true } }).toArray()
      const boosted = []
      const others = []
      for (const tool of tools) {
        if (tool.boosted === true && (!tool.boostExpiry || new Date(tool.boostExpiry) > now)) {
          boosted.push(tool)
        } else {
          others.push(tool)
        }
      }
      const orderedTools = [...boosted, ...others]
      res.json(orderedTools)
    } catch (error) {
      console.error("Error fetching ordered tools:", error)
      res.status(500).json({ error: "Failed to fetch ordered tools" })
    }
  })

  return router
}
