require("dotenv").config()
const express = require("express")
const cors = require("cors")
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb")
const app = express()
const PORT = process.env.PORT || 5000
const { Server } = require("socket.io")
const http = require("http")
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
})

app.use(cors())
app.use(express.json())

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pcjdk.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    deprecationErrors: true,
  },
})

let feedbackStorage
let messagesStorage
let toolsStorage
let usersStorage
let flaggedMessagesStorage
let sessionsStorage
let redirectTrackingStorage
let ragSystemStorage
let chatLogsStorage

async function run() {
  try {
    await client.connect()
    await client.db("admin").command({ ping: 1 })
    console.log("✅ Connected to MongoDB!")
    feedbackStorage = client.db("Toolmate").collection("Feedbacks")
    messagesStorage = client.db("Toolmate").collection("Messages")
    toolsStorage = client.db("Toolmate").collection("Tools")
    usersStorage = client.db("Toolmate").collection("Users")
    flaggedMessagesStorage = client.db("Toolmate").collection("FlaggedMessages")
    sessionsStorage = client.db("Toolmate").collection("Sessions")
    redirectTrackingStorage = client.db("Toolmate").collection("RedirectTracking")
    ragSystemStorage = client.db("Toolmate").collection("RagSystemStorage")
    chatLogsStorage = client.db("Toolmate").collection("ChatLogsStorage")
    server.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`)
      console.log(`🔌 Socket.io server is ready`)
    })
  } catch (err) {
    console.error("❌ MongoDB connection error:", err)
    process.exit(1) // Exit if DB connection fails
  }
}
run()
io.on("connection", (socket) => {
  console.log("✅ Admin connected for real-time monitoring:", socket.id)

  socket.on("join-monitoring", (data) => {
    console.log("📡 Client joined monitoring room:", socket.id)
    socket.join("admin-monitoring")
  })

  // Existing inject-message handler
  socket.on("inject-message", async (data) => {
    // Emit to the specific user's session
    io.to(data.sessionId).emit("admin-message", {
      message: data.message,
      timestamp: new Date(),
      sender: "matey", // Corrected: Always appear as Matey to the user
      sessionId: data.sessionId, // Forward sessionId
    })
    console.log(`📤 Admin ${socket.id} injected message to session ${data.sessionId}`)
  })

  // New: Admin starts typing/injecting process
  socket.on("admin-start-inject", (data) => {
    if (data.sessionId) {
      io.to(data.sessionId).emit("admin-typing-status", { isInjecting: true, sessionId: data.sessionId })
      console.log(`💬 Admin ${socket.id} started injecting for session ${data.sessionId}`)
    }
  })

  // New: Admin stops/cancels typing/injecting process
  socket.on("admin-end-inject", (data) => {
    if (data.sessionId) {
      io.to(data.sessionId).emit("admin-typing-status", { isInjecting: false, sessionId: data.sessionId })
      console.log(`🚫 Admin ${socket.id} ended injection for session ${data.sessionId}`)
    }
  })

  socket.on("disconnect", (reason) => {
    console.log("❌ Admin disconnected from monitoring:", socket.id, "Reason:", reason)
  })
})
async function emitNewLiveMessage(messageData) {
  try {
    let userDetails = null
    if (messageData.userEmail) {
      const emailToQuery = Array.isArray(messageData.userEmail) ? messageData.userEmail[0] : messageData.userEmail
      if (emailToQuery) {
        userDetails = await usersStorage.findOne({ userEmail: emailToQuery })
      }
    }
    const payload = {
      sessionId: messageData.sessionId,
      userName: messageData.userName || (userDetails ? userDetails.userName : "Unknown User"),
      userEmail: messageData.userEmail || (userDetails ? userDetails.userEmail : "N/A"),
      userImage: userDetails ? userDetails.userImage : null,
      timestamp: messageData.timestamp || new Date(),
      messageText: messageData.messageText,
    }
    io.to("admin-monitoring").emit("new-live-message", payload)
    console.log("📢 Emitted new-live-message to admin-monitoring room:", payload.sessionId)
  } catch (error) {
    console.error("Error emitting new live message:", error)
  }
}
function notifyActiveSessionsChanged() {
  io.to("admin-monitoring").emit("active-sessions-changed")
  console.log("🔄 Emitted active-sessions-changed to admin-monitoring room")
}

// Routes
app.get("/", (req, res) => {
  res.send("Welcome to Toolmate")
})

// Store and fetch feedbacks
app.post("/add-feedback", async (req, res) => {
  try {
    const data = req.body
    let existingFeedback = null
    if (Array.isArray(data.email) && data.email.length > 0) {
      const query = {
        messageId: data.messageId,
        email: { $in: data.email },
        reportStatus: data.reportStatus,
      }
      existingFeedback = await feedbackStorage.findOne(query)
    }
    if (existingFeedback) {
      res.send({ message: "Report is already added!" })
    } else {
      const result = await feedbackStorage.insertOne(data)
      if (data.reportStatus && data.feedback && data.feedback.reasons) {
        await flaggedMessagesStorage.insertOne({
          messageId: data.messageId,
          messageText: data.messageText,
          messageTimestamp: data.messageTimestamp,
          reasons: data.feedback.reasons,
          otherReason: data.feedback.otherReason || "",
          userEmail: data.email,
          isLoggedInUser: data.isLoggedInUser,
          status: "pending",
          adminComments: "",
          flaggedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
        })
      }
      res.status(200).send(result)
    }
  } catch (err) {
    console.error("Error adding feedback:", err)
    res.status(500).send({ error: "Failed to store feedback" })
  }
})

// Store and fetch messages
// This endpoint seems to be for bulk storing/updating a user's entire message history.
// If individual messages are added this way, we need to identify the *new* message.
app.post("/store-messages", async (req, res) => {
  try {
    const data = req.body // { userEmail, userName, messages: [...] }
    const emailArray = Array.isArray(data.userEmail) ? data.userEmail : [data.userEmail]

    const existingUserMessages = await messagesStorage.findOne({
      userEmail: { $elemMatch: { $in: emailArray } },
      userName: data.userName,
    })

    let result
    if (existingUserMessages) {
      result = await messagesStorage.updateOne({ _id: existingUserMessages._id }, { $set: { messages: data.messages } })
      res.send({ updated: true, result })
    } else {
      result = await messagesStorage.insertOne(data)
      res.send({ inserted: true, result })
    }

    // To emit a new message, we need to know which message is new.
    // This current structure replaces all messages.
    // If you want to emit the *last* message from the `data.messages` array:
    if (data.messages && data.messages.length > 0) {
      const lastMessage = data.messages[data.messages.length - 1]
      // Assuming `lastMessage` has a structure like { id, text, sender, timestamp }
      // And you have a `sessionId` associated with these messages.
      // This part needs more context on how `sessionId` relates to `messagesStorage`.
      // For now, let's assume `data` might contain `sessionId`.
      if (data.sessionId && lastMessage) {
        emitNewLiveMessage({
          sessionId: data.sessionId, // You'll need to ensure sessionId is available here
          userName: data.userName,
          userEmail: data.userEmail,
          timestamp: lastMessage.timestamp || new Date(),
          messageText: lastMessage.text, // Assuming 'text' field
        })
      }
    }
  } catch (error) {
    console.error("Error storing messages:", error)
    res.status(500).send({ error: "Internal server error" })
  }
})

app.get("/messages/:email", async (req, res) => {
  try {
    const email = req.params.email
    const query = { userEmail: email }
    const result = await messagesStorage.find(query).toArray()
    res.send(result)
  } catch (error) {
    res.status(500).send(error)
  }
})

// Store and fetch suggested Tools (similar logic to messages, may not need socket events)
app.post("/store-suggested-tools", async (req, res) => {
  try {
    const data = req.body
    const emailArray = data.userEmail
    const existingUser = await toolsStorage.findOne({
      userEmail: { $elemMatch: { $in: emailArray } },
      userName: data.userName,
    })
    if (existingUser) {
      const result = await toolsStorage.updateOne(
        { _id: existingUser._id },
        {
          $set: {
            suggestedTools: data.suggestedTools,
          },
        },
      )
      res.send({ updated: true, result })
    } else {
      const result = await toolsStorage.insertOne(data)
      res.send({ inserted: true, result })
    }
  } catch (error) {
    console.error("Error storing suggested tools:", error) // Corrected log message
    res.status(500).send({ error: "Internal server error" })
  }
})

app.get("/tools/:email", async (req, res) => {
  try {
    const email = req.params.email
    const query = { userEmail: email }
    const result = await toolsStorage.find(query).toArray()
    res.send(result)
  } catch (error) {
    res.status(500).send(error)
  }
})

// Create or update user
app.post("/store-user", async (req, res) => {
  try {
    const { userEmail, userName, userImage, isSubscribed, role } = req.body
    const existingUser = await usersStorage.findOne({ userEmail })
    if (existingUser) {
      const result = await usersStorage.updateOne(
        { userEmail },
        {
          $set: {
            userName,
            userImage,
            isSubscribed,
            role,
            updatedAt: new Date(),
          },
        },
      )
      res.json({ updated: true, result })
    } else {
      const userData = {
        userEmail,
        userName,
        userImage,
        isSubscribed: isSubscribed || false,
        role: role || "user",
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      const result = await usersStorage.insertOne(userData)
      res.json({ inserted: true, result })
    }
  } catch (error) {
    console.error("Error storing user:", error)
    res.status(500).json({ error: "Failed to store user" })
  }
})

// Get user by email
app.get("/user/:email", async (req, res) => {
  try {
    const { email } = req.params
    const user = await usersStorage.findOne({ userEmail: email })
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }
    res.json(user)
  } catch (error) {
    console.error("Error fetching user:", error)
    res.status(500).json({ error: "Failed to fetch user" })
  }
})

// Admin routes for users, flagged messages, etc. (largely unchanged for this issue)
// ... (Keep existing admin routes for users, flagged messages) ...
app.get("/admin/users", async (req, res) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query
    const skip = (page - 1) * limit
    const query = {}
    if (search) {
      query.$or = [{ userName: { $regex: search, $options: "i" } }, { userEmail: { $regex: search, $options: "i" } }]
    }
    if (role) {
      query.role = role
    }
    const users = await usersStorage
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray()
    const total = await usersStorage.countDocuments(query)
    res.json({
      users,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    })
  } catch (error) {
    console.error("Error fetching users:", error)
    res.status(500).json({ error: "Failed to fetch users" })
  }
})
app.put("/admin/users/:email", async (req, res) => {
  try {
    const { email } = req.params
    const { role, isSubscribed } = req.body
    const updateData = {
      updatedAt: new Date(),
    }
    if (role !== undefined) updateData.role = role
    if (isSubscribed !== undefined) updateData.isSubscribed = isSubscribed
    const result = await usersStorage.updateOne({ userEmail: email }, { $set: updateData })
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "User not found" })
    }
    res.json({ message: "User updated successfully" })
  } catch (error) {
    console.error("Error updating user:", error)
    res.status(500).json({ error: "Failed to update user" })
  }
})
app.get("/admin/flagged-messages", async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query
    const skip = (page - 1) * limit

    const query = {}
    if (status) {
      query.status = status
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
    res.status(500).json({ error: "Failed to fetch flagged messages" })
  }
})
app.put("/admin/flagged-messages/:id", async (req, res) => {
  try {
    const { id } = req.params
    const { status, adminComments, reviewedBy } = req.body

    const updateData = {
      status,
      adminComments,
      reviewedAt: new Date(),
      reviewedBy: reviewedBy || "admin",
    }

    const result = await flaggedMessagesStorage.updateOne({ _id: new ObjectId(id) }, { $set: updateData })

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Flagged message not found" })
    }

    res.json({ message: "Flagged message updated successfully" })
  } catch (error) {
    console.error("Error updating flagged message:", error)
    res.status(500).json({ error: "Failed to update flagged message" })
  }
})
app.get("/admin/flagged-messages/:id/context", async (req, res) => {
  try {
    const { id } = req.params

    const flaggedMessage = await flaggedMessagesStorage.findOne({ _id: new ObjectId(id) })
    if (!flaggedMessage) {
      return res.status(404).json({ error: "Flagged message not found" })
    }
    const session = await sessionsStorage.findOne({
      userEmail: { $in: flaggedMessage.userEmail },
      "messages.id": flaggedMessage.messageId,
    })
    const user = await usersStorage.findOne({
      userEmail: { $in: flaggedMessage.userEmail },
    })

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
app.post("/store-session", async (req, res) => {
  try {
    const {
      sessionId,
      userName,
      userEmail,
      prompt,
      mateyResponse,
      suggestedTools = [],
      budgetTier,
      flagTriggered = false,
      messages = [],
    } = req.body

    const timestamp = new Date()

    const sessionData = {
      sessionId,
      userName,
      userEmail,
      prompt,
      mateyResponse,
      suggestedTools,
      budgetTier,
      timestamp,
      flagTriggered,
      messages,
    }

    const logData = {
      sessionId,
      userEmail,
      userName,
      prompt,
      mateyResponse,
      suggestedTools,
      budgetTier,
      timestamp,
      flagTriggered,
      metadata: {
        userAgent: req.headers["user-agent"],
        ip: req.ip,
      },
    }
    const [sessionInsert, logInsert] = await Promise.all([
      sessionsStorage.insertOne(sessionData),
      chatLogsStorage.insertOne(logData),
    ])
    notifyActiveSessionsChanged()
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1]
      emitNewLiveMessage({
        sessionId,
        userName,
        userEmail,
        timestamp: lastMessage.timestamp || timestamp,
        messageText: lastMessage.text,
      })
    }

    res.json({
      success: true,
      sessionId: sessionInsert.insertedId,
      logId: logInsert.insertedId,
    })
  } catch (error) {
    console.error("Error storing session:", error)
    res.status(500).json({ error: "Failed to store session" })
  }
})
// Get chat logs for admin
app.get("/admin/chat-logs", async (req, res) => {
  try {
    const { page = 1, limit = 50, search, flaggedOnly } = req.query
    const skip = (page - 1) * limit

    const query = {}
    if (search) {
      query.$or = [
        { userName: { $regex: search, $options: "i" } },
        { prompt: { $regex: search, $options: "i" } },
        { mateyResponse: { $regex: search, $options: "i" } },
      ]
    }
    if (flaggedOnly === "true") {
      query.flagTriggered = true
    }
    const logs = await chatLogsStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray()
    const total = await chatLogsStorage.countDocuments(query)
    const enrichedLogs = await Promise.all(
      logs.map(async (log) => {
        const user = await usersStorage.findOne({
          userEmail: { $in: Array.isArray(log.userEmail) ? log.userEmail : [log.userEmail] },
        })
        return {
          ...log,
          userDetails: user || null,
        }
      }),
    )

    res.json({
      logs: enrichedLogs,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    })
  } catch (error) {
    console.error("Error fetching chat logs:", error)
    res.status(500).json({ error: "Failed to fetch chat logs" })
  }
})
// Get all sessions for admin
app.get("/admin/sessions", async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query
    const skip = (page - 1) * limit

    const query = {}
    if (search) {
      query.$or = [
        { userName: { $regex: search, $options: "i" } },
        { prompt: { $regex: search, $options: "i" } },
        // Add search by email if userEmail is a string, or handle array search
        // { userEmail: { $regex: search, $options: 'i' } }
      ]
    }

    const sessions = await sessionsStorage
      .find(query)
      .sort({ timestamp: -1 }) // Sort by most recent
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray()

    const total = await sessionsStorage.countDocuments(query)

    const enrichedSessions = await Promise.all(
      sessions.map(async (session) => {
        const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail
        const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null
        return {
          ...session,
          userDetails: user || null,
        }
      }),
    )

    res.json({
      sessions: enrichedSessions,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    })
  } catch (error) {
    console.error("Error fetching sessions:", error)
    res.status(500).json({ error: "Failed to fetch sessions" })
  }
})

// Get specific session details
app.get("/admin/sessions/:id", async (req, res) => {
  try {
    const { id } = req.params
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid session ID format" })
    }
    const session = await sessionsStorage.findOne({ _id: new ObjectId(id) })

    if (!session) {
      return res.status(404).json({ error: "Session not found" })
    }
    const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail
    const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null
    res.json({
      ...session,
      userDetails: user || null,
    })
  } catch (error) {
    console.error("Error fetching session:", error)
    res.status(500).json({ error: "Failed to fetch session" })
  }
})

// Get active sessions (e.g., updated in the last 5 minutes)
app.get("/admin/active-sessions", async (req, res) => {
  try {
    const fiveMinutesAgo = new Date()
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5)

    const activeSessions = await sessionsStorage
      .find({
        timestamp: { $gte: fiveMinutesAgo }, // Query for sessions updated recently
      })
      .sort({ timestamp: -1 })
      .toArray()

    const enrichedSessions = await Promise.all(
      activeSessions.map(async (session) => {
        const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail
        const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null
        return {
          ...session,
          userDetails: user || null,
        }
      }),
    )

    res.json(enrichedSessions)
  } catch (error) {
    console.error("Error fetching active sessions:", error)
    res.status(500).json({ error: "Failed to fetch active sessions" })
  }
})

// ... (Keep existing routes for redirect tracking, analytics, RAG system)
app.post("/track-redirect", async (req, res) => {
  try {
    const trackingData = {
      toolId: req.body.toolId,
      toolName: req.body.toolName,
      userEmail: req.body.userEmail,
      sessionId: req.body.sessionId,
      timestamp: new Date(),
      price: req.body.price,
      category: req.body.category,
      budgetTier: req.body.budgetTier,
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    }
    await redirectTrackingStorage.insertOne(trackingData)
    res.json({ success: true })
  } catch (error) {
    console.error("Error tracking redirect:", error)
    res.status(500).json({ error: "Failed to track redirect" })
  }
})
app.get("/admin/redirect-tracking", async (req, res) => {
  try {
    const { page = 1, limit = 50, toolId, dateFrom, dateTo } = req.query
    const skip = (page - 1) * limit
    const query = {}
    if (toolId) query.toolId = toolId
    if (dateFrom || dateTo) {
      query.timestamp = {}
      if (dateFrom) query.timestamp.$gte = new Date(dateFrom)
      if (dateTo) query.timestamp.$lte = new Date(dateTo)
    }
    const tracking = await redirectTrackingStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray()
    const total = await redirectTrackingStorage.countDocuments(query)
    const clickStats = await redirectTrackingStorage
      .aggregate([
        { $match: query },
        {
          $group: {
            _id: "$toolName",
            clicks: { $sum: 1 },
            toolId: { $first: "$toolId" },
          },
        },
        { $sort: { clicks: -1 } },
      ])
      .toArray()
    res.json({
      tracking,
      clickStats,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    })
  } catch (error) {
    console.error("Error fetching redirect tracking:", error)
    res.status(500).json({ error: "Failed to fetch redirect tracking" })
  }
})
app.get("/admin/analytics", async (req, res) => {
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
    const mostFlaggedTools = await flaggedMessagesStorage
      .aggregate([
        { $match: { flaggedAt: { $gte: startDate } } },
        {
          $lookup: {
            from: "Sessions",
            localField: "messageId",
            foreignField: "messages.id",
            as: "session",
          },
        },
        { $unwind: { path: "$session", preserveNullAndEmptyArrays: true } },
        { $unwind: { path: "$session.suggestedTools", preserveNullAndEmptyArrays: true } },
        { $group: { _id: "$session.suggestedTools.name", flagCount: { $sum: 1 } } },
        { $sort: { flagCount: -1 } },
        { $limit: 10 },
      ])
      .toArray()
    const flagsByReason = await flaggedMessagesStorage
      .aggregate([
        { $match: { flaggedAt: { $gte: startDate } } },
        { $unwind: "$reasons" },
        { $group: { _id: "$reasons", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray()
    const allToolsWithFlags = await flaggedMessagesStorage.distinct("messageId")
    const toolsWithNoFlags = await toolsStorage
      .aggregate([
        { $match: { "suggestedTools.id": { $nin: allToolsWithFlags } } },
        { $unwind: "$suggestedTools" },
        { $group: { _id: "$suggestedTools.products.name", count: { $sum: 1 } } },
      ])
      .toArray()
    const totalSessions = await sessionsStorage.countDocuments({ timestamp: { $gte: startDate } })
    const totalFlags = await flaggedMessagesStorage.countDocuments({ flaggedAt: { $gte: startDate } })
    const totalRedirects = await redirectTrackingStorage.countDocuments({ timestamp: { $gte: startDate } })
    const totalUsers = await usersStorage.countDocuments({ createdAt: { $gte: startDate } })
    const subscribedUsers = await usersStorage.countDocuments({ isSubscribed: true, createdAt: { $gte: startDate } })
    res.json({
      period,
      dateRange: { start: startDate, end: now },
      statistics: { totalSessions, totalFlags, totalRedirects, totalUsers, subscribedUsers },
      mostFlaggedTools,
      flagsByReason,
      toolsWithNoFlags: toolsWithNoFlags.slice(0, 10),
    })
  } catch (error) {
    console.error("Error fetching analytics:", error)
    res.status(500).json({ error: "Failed to fetch analytics" })
  }
})
app.get("/admin/rag-system", async (req, res) => {
  try {
    const ragSettings = await ragSystemStorage.find({}).toArray()
    res.json(ragSettings)
  } catch (error) {
    console.error("Error fetching RAG settings:", error)
    res.status(500).json({ error: "Failed to fetch RAG settings" })
  }
})
app.put("/admin/rag-system/tool/:id/visibility", async (req, res) => {
  try {
    const { id } = req.params
    const { hidden, updatedBy } = req.body
    await ragSystemStorage.updateOne(
      { id },
      { $set: { id, hidden, updatedAt: new Date(), updatedBy: updatedBy || "admin" } },
      { upsert: true },
    )
    res.json({ success: true, message: "Tool visibility updated" })
  } catch (error) {
    console.error("Error updating tool visibility:", error)
    res.status(500).json({ error: "Failed to update tool visibility" })
  }
})
app.put("/admin/rag-system/tool/:id/boost", async (req, res) => {
  try {
    const { id } = req.params
    const { boosted, duration, updatedBy } = req.body
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
    res.json({ success: true, message: "Tool boost updated" })
  } catch (error) {
    console.error("Error updating tool boost:", error)
    res.status(500).json({ error: "Failed to update tool boost" })
  }
})
app.get("/rag-system/boosted-tools", async (req, res) => {
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
app.get("/rag-system/hidden-tools", async (req, res) => {
  try {
    const hiddenTools = await ragSystemStorage.find({ hidden: true }).toArray()
    res.json(hiddenTools)
  } catch (error) {
    console.error("Error fetching hidden tools:", error)
    res.status(500).json({ error: "Failed to fetch hidden tools" })
  }
})
app.get("/rag-system/ordered-tools", async (req, res) => {
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
app.post("/api/v1/admin/login", (req, res) => {
  try {
    const { username, password } = req.body
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Username and password are required",
      })
    }
    const adminEmail = process.env.EMAIL
    const adminPassword = process.env.PASSWORD
    if (!adminEmail || !adminPassword) {
      return res.status(500).json({
        success: false,
        message: "Server configuration error",
      })
    }
    if (username === adminEmail && password === adminPassword) {
      const userData = {
        username: "Allan Davis",
        role: ["all"],
        permissions: ["all"],
        userEmail: "help@toolmate.com",
      }
      return res.status(200).json({
        success: true,
        message: "Login successful",
        ...userData,
      })
    } else {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      })
    }
  } catch (error) {
    console.error("Login error:", error)
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    })
  }
})
app.use((req, res) => {
  res.status(404).send({ error: "Not Found" })
})

app.use((err, req, res, next) => {
  console.error("Global error handler:", err.stack)
  res.status(500).send({ error: "Something went wrong!" })
})
