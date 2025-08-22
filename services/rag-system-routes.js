const express = require("express")
const { ObjectId } = require("mongodb")
module.exports = ({
  ragSystemStorage,
  shedToolsStorage,
  auditLogger,
  getUserInfoFromRequest,
  toolAnalyticsStorage,
  promoStorage,
  devTestOverrideStorage,
  io,
}) => {
  const router = express.Router()

  router.get("/admin/rag-system", async (req, res) => {
    try {
      const { page = 1, limit = 10 } = req.query
      const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit)

      const totalCount = await ragSystemStorage.countDocuments({})
      const ragSettings = await ragSystemStorage.find({}).skip(skip).limit(Number.parseInt(limit)).toArray()

      await toolAnalyticsStorage.insertOne({
        type: "admin_access",
        resource: "rag_system",
        timestamp: new Date(),
        userInfo: getUserInfoFromRequest(req),
      })

      res.json({
        data: ragSettings,
        pagination: {
          currentPage: Number.parseInt(page),
          totalPages: Math.ceil(totalCount / Number.parseInt(limit)),
          totalItems: totalCount,
          itemsPerPage: Number.parseInt(limit),
        },
      })
    } catch (error) {
      console.error("Error fetching RAG settings:", error)
      res.status(500).json({ error: "Failed to fetch RAG settings" })
    }
  })

  router.put("/admin/rag-system/tool/:id/visibility", async (req, res) => {
    try {
      const { id } = req.params
      const { hidden, suppressed, updatedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const existingTool = await ragSystemStorage.findOne({ id })
      await ragSystemStorage.updateOne(
        { id },
        {
          $set: {
            id,
            hidden: hidden || false,
            suppressed: suppressed || false,
            updatedAt: new Date(),
            updatedBy: updatedBy || "admin",
          },
        },
        { upsert: true },
      )
      io.to("admin-monitoring").emit("tool-visibility-updated", {
        toolId: id,
        hidden,
        suppressed,
        timestamp: new Date(),
      })
      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "rag_tool_visibility",
        resourceId: id,
        userId: updatedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: existingTool,
        newData: { hidden, suppressed, updatedAt: new Date(), updatedBy: updatedBy || "admin" },
        metadata: {
          toolId: id,
          visibilityChange: hidden ? "hidden" : suppressed ? "suppressed" : "visible",
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
      const { boosted, duration, promoExpiry, updatedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const existingTool = await ragSystemStorage.findOne({ id })
      let boostExpiry = null
      if (boosted && duration) {
        boostExpiry = new Date()
        boostExpiry.setMilliseconds(boostExpiry.getMilliseconds() + duration * 60 * 60 * 1000)
      }
      const updateData = {
        id,
        boosted,
        boostExpiry,
        updatedAt: new Date(),
        updatedBy: updatedBy || "admin",
      }
      if (promoExpiry) {
        updateData.promoExpiry = new Date(promoExpiry)
      }
      await ragSystemStorage.updateOne({ id }, { $set: updateData }, { upsert: true })

      io.to("admin-monitoring").emit("tool-boost-updated", {
        toolId: id,
        boosted,
        boostExpiry,
        promoExpiry,
        timestamp: new Date(),
        toolName: existingTool?.name || id,
        duration: duration || null,
        action: boosted ? "boosted" : "unboosted",
        remainingTime: boostExpiry ? boostExpiry.getTime() - new Date().getTime() : null,
      })

      io.emit("boost-status-changed", {
        toolId: id,
        toolName: existingTool?.name || id,
        boosted,
        boostExpiry,
        timestamp: new Date(),
      })

      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "rag_tool_boost",
        resourceId: id,
        userId: updatedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: existingTool,
        newData: updateData,
        metadata: {
          toolId: id,
          boostStatus: boosted ? "boosted" : "unboosted",
          boostDuration: duration,
          promoExpiry: promoExpiry,
          adminAction: true,
        },
        ...userInfo,
      })
      res.json({ success: true, message: "Tool boost updated", boostExpiry })
    } catch (error) {
      console.error("Error updating tool boost:", error)
      res.status(500).json({ error: "Failed to update tool boost" })
    }
  })

  router.put("/admin/rag-system/tool/:id/details", async (req, res) => {
    try {
      const { id } = req.params
      const { name, description, category, budgetTier, toolType, pricing, updatedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const existingTool = await ragSystemStorage.findOne({ id })
      const updateData = {
        updatedAt: new Date(),
        updatedBy: updatedBy || "admin",
      }
      if (name !== undefined) updateData.product_name = name
      if (name !== undefined) updateData.display_name = name
      if (description !== undefined) updateData.product_type = description
      if (category !== undefined) updateData.retailer = category
      if (toolType !== undefined) updateData.toolType = toolType
      if (budgetTier !== undefined) {
        const riskLevelMap = {
          low: "Low",
          medium: "Medium",
          hard: "Hard",
          Low: "Low",
          Medium: "Medium",
          Hard: "Hard",
        }
        updateData.risk_level = riskLevelMap[budgetTier] || budgetTier
      }
      if (pricing !== undefined) updateData.pricing = pricing

      await ragSystemStorage.updateOne({ id }, { $set: updateData })
      io.to("admin-monitoring").emit("tool-details-updated", {
        toolId: id,
        updatedFields: Object.keys(updateData).filter((k) => k !== "updatedAt" && k !== "updatedBy"),
        timestamp: new Date(),
      })
      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "rag_tool_details",
        resourceId: id,
        userId: updatedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: existingTool,
        newData: updateData,
        metadata: {
          toolId: id,
          updatedFields: Object.keys(updateData).filter((k) => k !== "updatedAt" && k !== "updatedBy"),
          adminAction: true,
        },
        ...userInfo,
      })
      res.json({ success: true, message: "Tool details updated" })
    } catch (error) {
      console.error("Error updating tool details:", error)
      res.status(500).json({ error: "Failed to update tool details" })
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

  router.get("/rag-system/filtered-tools", async (req, res) => {
    try {
      const { risk_level, productNames, userID } = req.query
      console.log("Query params:", { risk_level, productNames, userID })

      const initialMatchQuery = {
        hidden: { $ne: true },
        suppressed: { $ne: true },
      }

      if (risk_level) {
        let riskLevelsToInclude = []
        if (risk_level === "Low") riskLevelsToInclude = ["Low"]
        else if (risk_level === "Medium") riskLevelsToInclude = ["Low", "Medium"]
        else if (risk_level === "Hard") riskLevelsToInclude = ["Low", "Medium", "Hard"]

        if (riskLevelsToInclude.length > 0) {
          initialMatchQuery.risk_level = { $in: riskLevelsToInclude }
        }
      }
      const searchTerms = []
      if (productNames) {
        searchTerms.push(
          ...productNames
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t && t.toLowerCase() !== "i"),
        )
      }
      if (searchTerms.length > 0) {
        initialMatchQuery.$or = searchTerms.flatMap((term) => [
          { product_name: { $regex: term, $options: "i" } },
          { product_type: { $regex: term, $options: "i" } },
          { retailer: { $regex: term, $options: "i" } },
        ])
      }
      const pipeline = [{ $match: initialMatchQuery }]
      if (searchTerms.length > 0) {
        const keywordRelevantOrConditions = searchTerms.flatMap((term) => [
          { $regexMatch: { input: "$product_name", regex: term, options: "i" } },
          { $regexMatch: { input: "$product_type", regex: term, options: "i" } },
          { $regexMatch: { input: "$retailer", regex: term, options: "i" } },
        ])
        pipeline.push({
          $addFields: {
            _isBoosted: {
              $and: [
                { $eq: ["$boosted", true] },
                { $or: [{ $eq: ["$boostExpiry", null] }, { $gt: ["$boostExpiry", "$$NOW"] }] },
              ],
            },
            _isKeywordRelevant: { $or: keywordRelevantOrConditions },
            _hasActivePromo: {
              $and: [{ $ne: ["$promoExpiry", null] }, { $gt: ["$promoExpiry", "$$NOW"] }],
            },
          },
        })
      } else {
        pipeline.push({
          $addFields: {
            _isBoosted: {
              $and: [
                { $eq: ["$boosted", true] },
                { $or: [{ $eq: ["$boostExpiry", null] }, { $gt: ["$boostExpiry", "$$NOW"] }] },
              ],
            },
            _isKeywordRelevant: false,
            _hasActivePromo: {
              $and: [{ $ne: ["$promoExpiry", null] }, { $gt: ["$promoExpiry", "$$NOW"] }],
            },
          },
        })
      }
      pipeline.push({
        $sort: {
          _isKeywordRelevant: -1,
          _isBoosted: -1,
          _hasActivePromo: -1,
        },
      })
      let results = await ragSystemStorage.aggregate(pipeline).toArray()
      const removedTools = []
      if (userID) {
        const shedTools = await shedToolsStorage
          .find({ user_id: userID, collection: { $ne: "shed_analytics" } })
          .toArray()
        const shedToolNames = new Set(shedTools.map((t) => t.tool_name?.toLowerCase()))
        const filteredResults = []
        for (const tool of results) {
          const words = tool.product_name.split(" ").map((w) => w.toLowerCase())
          const firstWord = words[0] || ""
          const secondWord = words[1] || ""
          if (shedToolNames.has(firstWord) || shedToolNames.has(secondWord)) {
            removedTools.push(tool.product_name)
          } else {
            filteredResults.push(tool)
          }
        }
        results = filteredResults
      }

      let finalTools = []
      if (results.length > 0) {
        const grouped = {}
        results.forEach((tool) => {
          const key = tool.retailer || "general"
          if (!grouped[key]) grouped[key] = []
          grouped[key].push(tool)
        })

        Object.values(grouped).forEach((group) => {
          if (group.length >= 3) {
            finalTools.push(...group.slice(0, 3))
          } else if (group.length >= 2) {
            finalTools.push(...group.slice(0, 2))
          } else {
            finalTools.push(...group)
          }
        })

        finalTools = finalTools.slice(0, 5)
      }

      await toolAnalyticsStorage.insertOne({
        type: "filtered_search",
        timestamp: new Date(),
        filters: { risk_level },
        searchTerms,
        userID,
        resultCount: finalTools.length,
        removedToolsCount: removedTools.length,
      })

      res.json({
        finalTools,
        removedTools,
        searchMetadata: {
          totalFound: results.length,
          filteredByUser: removedTools.length,
          finalCount: finalTools.length,
          goodBetterBest: finalTools.length > 1,
        },
      })
    } catch (error) {
      console.error("Error in filtered-tools:", error)
      res.status(500).json({ error: "Failed to fetch filtered tools" })
    }
  })

  router.get("/admin/rag-system/analytics", async (req, res) => {
    try {
      const { startDate, endDate, type } = req.query
      const matchQuery = {}
      if (startDate && endDate) {
        matchQuery.timestamp = {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        }
      }
      if (type) {
        matchQuery.type = type
      }
      const analytics = await toolAnalyticsStorage.find(matchQuery).sort({ timestamp: -1 }).limit(1000).toArray()
      res.json(analytics)
    } catch (error) {
      console.error("Error fetching analytics:", error)
      res.status(500).json({ error: "Failed to fetch analytics" })
    }
  })
  router.post("/admin/dev-test-override", async (req, res) => {
    try {
      const { overrideKey, description, durationHours, updatedBy } = req.body
      const userInfo = getUserInfoFromRequest(req)
      const expiresAt = new Date()
      expiresAt.setHours(expiresAt.getHours() + (durationHours || 24))
      const override = {
        overrideKey,
        description,
        active: true,
        createdAt: new Date(),
        expiresAt,
        createdBy: updatedBy || "admin",
      }
      await devTestOverrideStorage.insertOne(override)
      await auditLogger.logAudit({
        action: "CREATE",
        resource: "dev_test_override",
        resourceId: overrideKey,
        userId: updatedBy || "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        newData: override,
        metadata: {
          overrideKey,
          durationHours,
          adminAction: true,
        },
        ...userInfo,
      })
      res.json({ success: true, message: "Dev/test override created", override })
    } catch (error) {
      console.error("Error creating dev/test override:", error)
      res.status(500).json({ error: "Failed to create dev/test override" })
    }
  })

  return router
}
