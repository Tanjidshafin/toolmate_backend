const express = require("express")
const { ObjectId } = require("mongodb")

module.exports = ({ shedToolsStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()

  router.post("/shed/add", async (req, res) => {
    try {
      const { userId, toolName, category, originalPhrase, source } = req.body
      const userInfo = getUserInfoFromRequest(req)

      if (!userId || !toolName) {
        return res.status(400).json({
          success: false,
          error: "User ID and tool name are required",
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const existingTool = await shedToolsStorage.findOne({
        user_id: userId,
        tool_name: { $regex: new RegExp(`^${toolName}$`, "i") },
        collection: { $ne: "shed_analytics" },
      })
      if (existingTool) {
        return res.json({
          success: true,
          message: "Tool already in shed",
          toolId: existingTool._id,
        })
      }
      const toolData = {
        user_id: userId,
        tool_name: toolName,
        category: category || "Other",
        date_added: new Date(),
        source: source || "chat",
        original_phrase: originalPhrase || "",
        last_updated: new Date(),
        note: "",
      }
      const result = await shedToolsStorage.insertOne(toolData)

      // Log audit for shed tool addition
      await auditLogger.logAudit({
        action: "CREATE",
        resource: "shed_tool",
        resourceId: result.insertedId.toString(),
        userId: userId,
        userEmail: userId, // Using userId as email identifier
        role: "user",
        newData: toolData,
        metadata: {
          toolName: toolName,
          category: category || "Other",
          source: source || "chat",
        },
        ...userInfo,
      })

      try {
        await shedToolsStorage.insertOne({
          collection: "shed_analytics",
          user_id: userId,
          action: "tool_added",
          tool_name: toolName,
          category: category || "Other",
          timestamp: new Date(),
          source: source || "chat",
        })
      } catch (analyticsError) {
        console.warn("Analytics insertion failed:", analyticsError)
      }
      res.json({
        success: true,
        toolId: result.insertedId,
        message: "Tool added to shed successfully",
        tool: { ...toolData, _id: result.insertedId },
      })
    } catch (error) {
      console.error("Error adding tool to shed:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.delete("/shed/remove/:toolId", async (req, res) => {
    try {
      const { toolId } = req.params
      const userInfo = getUserInfoFromRequest(req)

      if (!ObjectId.isValid(toolId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid tool ID format",
        })
      }
      const toolDoc = await shedToolsStorage.findOne({
        _id: new ObjectId(toolId),
        collection: { $ne: "shed_analytics" },
      })
      if (!toolDoc) {
        return res.status(404).json({
          success: false,
          error: "Tool not found in shed",
        })
      }
      const result = await shedToolsStorage.deleteOne({
        _id: new ObjectId(toolId),
        collection: { $ne: "shed_analytics" },
      })
      if (result.deletedCount === 0) {
        return res.status(404).json({
          success: false,
          error: "Tool not found or could not be deleted",
        })
      }

      // Log audit for shed tool removal
      await auditLogger.logAudit({
        action: "DELETE",
        resource: "shed_tool",
        resourceId: toolId,
        userId: toolDoc.user_id,
        userEmail: toolDoc.user_id,
        role: "user",
        oldData: toolDoc,
        metadata: {
          toolName: toolDoc.tool_name,
          category: toolDoc.category,
        },
        ...userInfo,
      })

      try {
        await shedToolsStorage.insertOne({
          collection: "shed_analytics",
          user_id: toolDoc.user_id,
          action: "tool_removed",
          tool_name: toolDoc.tool_name,
          category: toolDoc.category,
          timestamp: new Date(),
          source: "manual",
        })
      } catch (analyticsError) {
        console.warn("Analytics insertion failed:", analyticsError)
      }
      res.json({
        success: true,
        message: "Tool removed from shed successfully",
        removedTool: toolDoc.tool_name,
      })
    } catch (error) {
      console.error("Error removing tool from shed:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })
  router.get("/shed/:userId", async (req, res) => {
    try {
      const { userId } = req.params

      const tools = await shedToolsStorage
        .find({
          user_id: userId,
          collection: { $ne: "shed_analytics" },
        })
        .sort({ date_added: -1 })
        .toArray()
      const groupedTools = tools.reduce((acc, tool) => {
        const category = tool.category || "Other"
        if (!acc[category]) {
          acc[category] = []
        }
        acc[category].push(tool)
        return acc
      }, {})
      res.json({
        success: true,
        tools: tools,
        groupedTools: groupedTools,
        totalCount: tools.length,
      })
    } catch (error) {
      console.error("Error fetching shed tools:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.put("/shed/update/:toolId", async (req, res) => {
    try {
      const { toolId } = req.params
      const { toolName, category, note } = req.body
      const userInfo = getUserInfoFromRequest(req)

      if (!ObjectId.isValid(toolId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid tool ID format",
        })
      }
      const existingTool = await shedToolsStorage.findOne({ _id: new ObjectId(toolId) })
      if (!existingTool) {
        return res.status(404).json({
          success: false,
          error: "Tool not found in shed",
        })
      }

      const updateData = {
        last_updated: new Date(),
      }
      if (toolName) updateData.tool_name = toolName
      if (category) updateData.category = category
      if (note !== undefined) updateData.note = note
      const result = await shedToolsStorage.updateOne({ _id: new ObjectId(toolId) }, { $set: updateData })
      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          error: "Tool not found in shed",
        })
      }

      // Log audit for shed tool update
      await auditLogger.logAudit({
        action: "UPDATE",
        resource: "shed_tool",
        resourceId: toolId,
        userId: existingTool.user_id,
        userEmail: existingTool.user_id,
        role: "user",
        oldData: existingTool,
        newData: updateData,
        metadata: {
          updatedFields: Object.keys(updateData).filter((key) => key !== "last_updated"),
        },
        ...userInfo,
      })

      const updatedTool = await shedToolsStorage.findOne({ _id: new ObjectId(toolId) })
      res.json({
        success: true,
        message: "Tool updated successfully",
        tool: updatedTool,
      })
    } catch (error) {
      console.error("Error updating tool in shed:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.delete("/shed/clear/:userId", async (req, res) => {
    try {
      const { userId } = req.params
      const userInfo = getUserInfoFromRequest(req)

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: "User ID is required",
        })
      }
      const tools = await shedToolsStorage.find({ user_id: userId }).toArray()
      const toolCount = tools.length
      if (toolCount === 0) {
        return res.json({
          success: true,
          message: "Shed is already empty",
          toolsRemoved: 0,
        })
      }
      const result = await shedToolsStorage.deleteMany({ user_id: userId })

      // Log audit for shed clear
      await auditLogger.logAudit({
        action: "DELETE_BULK",
        resource: "shed_tools",
        resourceId: userId,
        userId: userId,
        userEmail: userId,
        role: "user",
        oldData: {
          toolCount: toolCount,
          tools: tools.map((t) => ({ name: t.tool_name, category: t.category })),
        },
        metadata: {
          action: "shed_cleared",
          toolsCount: toolCount,
        },
        ...userInfo,
      })

      await shedToolsStorage.insertOne({
        collection: "shed_analytics",
        user_id: userId,
        action: "shed_cleared",
        tools_count: toolCount,
        timestamp: new Date(),
        source: "manual",
      })

      res.json({
        success: true,
        message: "Shed cleared successfully",
        toolsRemoved: result.deletedCount,
      })
    } catch (error) {
      console.error("Error clearing shed:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.post("/shed/check-ownership", async (req, res) => {
    try {
      const { userId, toolNames } = req.body
      if (!userId || !Array.isArray(toolNames)) {
        return res.status(400).json({
          success: false,
          error: "User ID and tool names array are required",
        })
      }
      const ownedTools = await shedToolsStorage
        .find({
          user_id: userId,
          tool_name: { $in: toolNames.map((name) => new RegExp(name, "i")) },
        })
        .toArray()
      const ownedToolNames = ownedTools.map((tool) => tool.tool_name.toLowerCase())
      const ownership = toolNames.reduce((acc, toolName) => {
        acc[toolName] = ownedToolNames.some(
          (owned) => owned.includes(toolName.toLowerCase()) || toolName.toLowerCase().includes(owned),
        )
        return acc
      }, {})
      res.json({
        success: true,
        ownership: ownership,
        ownedTools: ownedTools.map((tool) => ({
          id: tool._id,
          name: tool.tool_name,
          category: tool.category,
        })),
      })
    } catch (error) {
      console.error("Error checking tool ownership:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.get("/admin/shed-analytics", async (req, res) => {
    try {
      const { page = 1, limit = 50, action, userId, dateFrom, dateTo, period } = req.query
      const skip = (page - 1) * limit

      const query = { collection: "shed_analytics" }

      if (action) query.action = action
      if (userId) query.user_id = userId

      // Handle period-based filtering (similar to analytics endpoint)
      if (period) {
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

        query.timestamp = { $gte: startDate }
      } else if (dateFrom || dateTo) {
        // Handle custom date range
        query.timestamp = {}
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom)
        if (dateTo) query.timestamp.$lte = new Date(dateTo)
      }

      const analytics = await shedToolsStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray()

      const total = await shedToolsStorage.countDocuments(query)

      const stats = await shedToolsStorage
        .aggregate([
          { $match: { collection: "shed_analytics", ...query } },
          {
            $group: {
              _id: "$action",
              count: { $sum: 1 },
            },
          },
        ])
        .toArray()

      const popularTools = await shedToolsStorage
        .aggregate([
          {
            $match: {
              collection: "shed_analytics",
              action: "tool_added",
              ...query,
            },
          },
          {
            $group: {
              _id: "$tool_name",
              count: { $sum: 1 },
              category: { $first: "$category" },
            },
          },
          { $sort: { count: -1 } },
          { $limit: 10 },
        ])
        .toArray()

      res.json({
        success: true,
        analytics: analytics,
        stats: stats.reduce((acc, stat) => {
          acc[stat._id] = stat.count
          return acc
        }, {}),
        popularTools: popularTools,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      })
    } catch (error) {
      console.error("Error fetching shed analytics:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.get("/admin/shed-stats", async (req, res) => {
    try {
      const { period, dateFrom, dateTo } = req.query
      let timeQuery = {}
      if (period) {
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

        timeQuery = { date_added: { $gte: startDate } }
      } else if (dateFrom || dateTo) {
        timeQuery.date_added = {}
        if (dateFrom) timeQuery.date_added.$gte = new Date(dateFrom)
        if (dateTo) timeQuery.date_added.$lte = new Date(dateTo)
      }

      const totalTools = await shedToolsStorage.countDocuments({
        collection: { $ne: "shed_analytics" },
        ...timeQuery,
      })

      const totalUsers = await shedToolsStorage.distinct("user_id", {
        collection: { $ne: "shed_analytics" },
        ...timeQuery,
      })

      const categoryStats = await shedToolsStorage
        .aggregate([
          {
            $match: {
              collection: { $ne: "shed_analytics" },
              ...timeQuery,
            },
          },
          {
            $group: {
              _id: "$category",
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
        ])
        .toArray()
      // Get tools added over time for trend analysis
      const toolsOverTime = await shedToolsStorage
        .aggregate([
          {
            $match: {
              collection: { $ne: "shed_analytics" },
              ...timeQuery,
            },
          },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$date_added",
                },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray()

      // Get most active users in the period
      const mostActiveUsers = await shedToolsStorage
        .aggregate([
          {
            $match: {
              collection: { $ne: "shed_analytics" },
              ...timeQuery,
            },
          },
          {
            $group: {
              _id: "$user_id",
              toolCount: { $sum: 1 },
            },
          },
          { $sort: { toolCount: -1 } },
          { $limit: 10 },
        ])
        .toArray()

      const averageToolsPerUser = totalUsers.length > 0 ? totalTools / totalUsers.length : 0

      res.json({
        success: true,
        stats: {
          totalTools: totalTools,
          totalUsersWithTools: totalUsers.length,
          averageToolsPerUser: Math.round(averageToolsPerUser * 100) / 100,
          categoryBreakdown: categoryStats,
          toolsOverTime: toolsOverTime,
          mostActiveUsers: mostActiveUsers,
        },
        period: period || "all",
        dateRange: period
          ? {
              start: (() => {
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
                return startDate
              })(),
              end: new Date(),
            }
          : null,
      })
    } catch (error) {
      console.error("Error fetching shed statistics:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  router.post("/shed/bulk-add", async (req, res) => {
    try {
      const { userId, tools } = req.body
      const userInfo = getUserInfoFromRequest(req)

      if (!userId || !Array.isArray(tools) || tools.length === 0) {
        return res.status(400).json({
          success: false,
          error: "User ID and tools array are required",
        })
      }

      const toolsToInsert = tools.map((tool) => ({
        user_id: userId,
        tool_name: tool.name || tool.toolName,
        category: tool.category || "Other",
        date_added: new Date(),
        source: tool.source || "bulk_import",
        original_phrase: tool.originalPhrase || "",
        last_updated: new Date(),
        note: tool.note || "",
      }))
      const result = await shedToolsStorage.insertMany(toolsToInsert)

      // Log audit for bulk tool addition
      await auditLogger.logAudit({
        action: "CREATE_BULK",
        resource: "shed_tools",
        resourceId: userId,
        userId: userId,
        userEmail: userId,
        role: "user",
        newData: {
          toolsCount: toolsToInsert.length,
          tools: toolsToInsert.map((t) => ({ name: t.tool_name, category: t.category })),
        },
        metadata: {
          bulkImport: true,
          source: "bulk_import",
        },
        ...userInfo,
      })

      // Log analytics
      await shedToolsStorage.insertOne({
        collection: "shed_analytics",
        user_id: userId,
        action: "bulk_import",
        tools_count: toolsToInsert.length,
        timestamp: new Date(),
        source: "admin",
      })
      res.json({
        success: true,
        message: `${result.insertedCount} tools added to shed successfully`,
        insertedCount: result.insertedCount,
        toolIds: result.insertedIds,
      })
    } catch (error) {
      console.error("Error bulk adding tools to shed:", error)
      res.status(500).json({ success: false, error: error.message })
    }
  })

  return router
}
