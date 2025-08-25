const express = require("express")
const router = express.Router()
module.exports = (dependencies) => {
  const { ObjectId, blogsStorage, auditLogger, getUserInfoFromRequest } = dependencies
  router.get("/api/blogs", async (req, res) => {
    try {
      const { page = 1, limit = 10, category, tag, search, sortBy = "publishedDate", sortOrder = "desc" } = req.query
      const skip = (Number.parseInt(page) - 1) * Number.parseInt(limit)
      const query = {}
      if (category) {
        query.category = category
      }
      if (tag) {
        query.tags = { $in: [tag] }
      }
      if (search) {
        query.$or = [
          { title: { $regex: search, $options: "i" } },
          { excerpt: { $regex: search, $options: "i" } },
        ]
      }
      const sort = {}
      sort[sortBy] = sortOrder === "desc" ? -1 : 1
      const blogs = await blogsStorage.find(query).sort(sort).skip(skip).limit(Number.parseInt(limit)).toArray()
      const total = await blogsStorage.countDocuments(query)
      const totalPages = Math.ceil(total / Number.parseInt(limit))
      res.json({
        success: true,
        data: {
          blogs,
          pagination: {
            currentPage: Number.parseInt(page),
            totalPages,
            totalBlogs: total,
            hasNextPage: Number.parseInt(page) < totalPages,
            hasPrevPage: Number.parseInt(page) > 1,
          },
        },
      })
    } catch (error) {
      console.error("Error fetching blogs:", error)
      res.status(500).json({
        success: false,
        error: "Failed to fetch blogs",
      })
    }
  })
  router.get("/api/blogs/:id", async (req, res) => {
    try {
      const { id } = req.params
      let query
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) }
      } else {
        query = { id: Number.parseInt(id) }
      }
      const blog = await blogsStorage.findOne(query)
      if (!blog) {
        return res.status(404).json({
          success: false,
          error: "Blog not found",
        })
      }
      res.json(blog)
    } catch (error) {
      console.error("Error fetching blog:", error)
      res.status(500).json({
        success: false,
        error: "Failed to fetch blog",
      })
    }
  })
  router.get("/api/blogs/category/:category", async (req, res) => {
    try {
      const { category } = req.params
      const { limit = 5 } = req.query
      const blogs = await blogsStorage
        .find({ category })
        .sort({ publishedDate: -1 })
        .limit(Number.parseInt(limit))
        .toArray()
      res.json(blogs)
    } catch (error) {
      console.error("Error fetching blogs by category:", error)
      res.status(500).json({
        success: false,
        error: "Failed to fetch blogs by category",
      })
    }
  })
  router.get("/api/blogs/popular", async (req, res) => {
    try {
      const { limit = 4 } = req.query
      const blogs = await blogsStorage.find({}).sort({ publishedDate: -1 }).limit(Number.parseInt(limit)).toArray()
      res.json({
        success: true,
        data: blogs,
      })
    } catch (error) {
      console.error("Error fetching popular blogs:", error)
      res.status(500).json({
        success: false,
        error: "Failed to fetch popular blogs",
      })
    }
  })
  router.get("/api/blogs/tags", async (req, res) => {
    try {
      const tags = await blogsStorage.distinct("tags")
      res.json({
        success: true,
        data: tags.filter((tag) => tag && tag.trim() !== ""),
      })
    } catch (error) {
      console.error("Error fetching tags:", error)
      res.status(500).json({
        success: false,
        error: "Failed to fetch tags",
      })
    }
  })
  router.get("/api/blogs/categories", async (req, res) => {
    try {
      const categories = await blogsStorage.distinct("category")
      res.json({
        success: true,
        data: categories.filter((category) => category && category.trim() !== ""),
      })
    } catch (error) {
      console.error("Error fetching categories:", error)
      res.status(500).json({
        success: false,
        error: "Failed to fetch categories",
      })
    }
  })
  router.post("/api/blogs", async (req, res) => {
    try {
      const blogData = {
        ...req.body,
        publishedDate: req.body.publishedDate || new Date().toISOString(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const result = await blogsStorage.insertOne(blogData)
      await auditLogger.logAudit({
        action: "CREATE_BLOG",
        resource: "blog",
        resourceId: result.insertedId.toString(),
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        newData: blogData,
        metadata: getUserInfoFromRequest(req),
      })
      res.status(201).json({
        success: true,
        data: { ...blogData, _id: result.insertedId },
      })
    } catch (error) {
      console.error("Error creating blog:", error)
      res.status(500).json({
        success: false,
        error: "Failed to create blog",
      })
    }
  })
  router.put("/api/blogs/:id", async (req, res) => {
    try {
      const { id } = req.params
      const updateData = {
        ...req.body,
        updatedAt: new Date(),
      }
      let query
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) }
      } else {
        query = { id: Number.parseInt(id) }
      }
      const result = await blogsStorage.updateOne(query, { $set: updateData })
      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          error: "Blog not found",
        })
      }
      await auditLogger.logAudit({
        action: "UPDATE_BLOG",
        resource: "blog",
        resourceId: id,
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        newData: updateData,
        metadata: getUserInfoFromRequest(req),
      })
      res.json({
        success: true,
        message: "Blog updated successfully",
      })
    } catch (error) {
      console.error("Error updating blog:", error)
      res.status(500).json({
        success: false,
        error: "Failed to update blog",
      })
    }
  })
  router.delete("/api/blogs/:id", async (req, res) => {
    try {
      const { id } = req.params
      let query
      if (ObjectId.isValid(id)) {
        query = { _id: new ObjectId(id) }
      } else {
        query = { id: Number.parseInt(id) }
      }
      const blog = await blogsStorage.findOne(query)
      if (!blog) {
        return res.status(404).json({
          success: false,
          error: "Blog not found",
        })
      }
      await blogsStorage.deleteOne(query)
      await auditLogger.logAudit({
        action: "DELETE_BLOG",
        resource: "blog",
        resourceId: id,
        userId: "admin",
        userEmail: "admin@toolmate.com",
        role: "admin",
        oldData: blog,
        metadata: getUserInfoFromRequest(req),
      })
      res.json({
        success: true,
        message: "Blog deleted successfully",
      })
    } catch (error) {
      console.error("Error deleting blog:", error)
      res.status(500).json({
        success: false,
        error: "Failed to delete blog",
      })
    }
  })

  return router
}
