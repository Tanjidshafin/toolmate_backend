require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClerkClient } = require('@clerk/clerk-sdk-node');
const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const EmailService = require('./services/emailService');
const EmailTriggers = require('./services/emailTriggers');
const app = express();
const PORT = process.env.PORT || 5000;
const { Server } = require('socket.io');
const http = require('http');
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pcjdk.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    deprecationErrors: true,
  },
});

let feedbackStorage;
let messagesStorage;
let toolsStorage;
let usersStorage;
let flaggedMessagesStorage;
let sessionsStorage;
let redirectTrackingStorage;
let ragSystemStorage;
let chatLogsStorage;
let shedToolsStorage;
let emailLogsStorage;
let emailService;
let emailTriggers;
async function run() {
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('✅ Connected to MongoDB!');
    feedbackStorage = client.db('Toolmate').collection('Feedbacks');
    messagesStorage = client.db('Toolmate').collection('Messages');
    toolsStorage = client.db('Toolmate').collection('Tools');
    usersStorage = client.db('Toolmate').collection('Users');
    flaggedMessagesStorage = client.db('Toolmate').collection('FlaggedMessages');
    sessionsStorage = client.db('Toolmate').collection('Sessions');
    redirectTrackingStorage = client.db('Toolmate').collection('RedirectTracking');
    ragSystemStorage = client.db('Toolmate').collection('RagSystemStorage');
    chatLogsStorage = client.db('Toolmate').collection('ChatLogsStorage');
    shedToolsStorage = client.db('Toolmate').collection('ShedTools');
    emailLogsStorage = client.db('Toolmate').collection('EmailLogs');
    emailService = new EmailService(emailLogsStorage);
    emailTriggers = new EmailTriggers(emailService);
    server.listen(PORT, () => {
      console.log(`🚀 Server is running on port ${PORT}`);
      console.log(`🔌 Socket.io server is ready`);
    });
  } catch (err) {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
  }
}

run();
io.on('connection', (socket) => {
  console.log('✅ Admin connected for real-time monitoring:', socket.id);
  socket.on('join-monitoring', (data) => {
    console.log('📡 Client joined monitoring room:', socket.id);
    socket.join('admin-monitoring');
  });
  socket.on('inject-message', async (data) => {
    try {
      io.to(data.sessionId).emit('admin-message', {
        message: data.message,
        timestamp: new Date(),
        sender: 'admin',
      });
      let userDetails = null;
      const recentSession = await chatLogsStorage.findOne({ sessionId: data.sessionId }, { sort: { timestamp: -1 } });
      if (recentSession) {
        userDetails = {
          userEmail: recentSession.userEmail,
          userName: recentSession.userName,
        };
      } else {
        const session = await sessionsStorage.findOne({ sessionId: data.sessionId }, { sort: { timestamp: -1 } });
        if (session) {
          userDetails = {
            userEmail: session.userEmail,
            userName: session.userName,
          };
        }
      }
      io.to('admin-monitoring').emit('injected-message-confirmation', {
        sessionId: data.sessionId,
        message: data.message,
        timestamp: new Date(),
        sender: 'admin',
        status: 'sent',
        userEmail: userDetails?.userEmail || 'Unknown',
        userName: userDetails?.userName || 'Unknown User',
      });
      console.log(
        `📤 Admin ${socket.id} injected message to session ${data.sessionId} for user ${
          userDetails?.userName || 'Unknown'
        }`
      );
    } catch (error) {
      console.error('Error injecting message:', error);
      io.to('admin-monitoring').emit('injected-message-confirmation', {
        sessionId: data.sessionId,
        message: data.message,
        timestamp: new Date(),
        sender: 'admin',
        status: 'error',
        error: 'Failed to inject message',
        userEmail: 'Unknown',
        userName: 'Unknown User',
      });
    }
  });
  socket.on('disconnect', (reason) => {
    console.log('❌ Admin disconnected from monitoring:', socket.id, 'Reason:', reason);
  });
});
async function emitNewLiveMessage(messageData) {
  try {
    let userDetails = null;
    if (messageData.userEmail) {
      const emailToQuery = Array.isArray(messageData.userEmail) ? messageData.userEmail[0] : messageData.userEmail;
      if (emailToQuery) {
        userDetails = await usersStorage.findOne({ userEmail: emailToQuery });
      }
    }
    const payload = {
      sessionId: messageData.sessionId,
      userName: messageData.userName || (userDetails ? userDetails.userName : 'Unknown User'),
      userEmail: messageData.userEmail || (userDetails ? userDetails.userEmail : 'N/A'),
      userImage: userDetails ? userDetails.userImage : null,
      timestamp: messageData.timestamp || new Date(),
      messageText: messageData.messageText,
      prompt: messageData.userPrompt,
    };
    io.to('admin-monitoring').emit('new-live-message', payload);
    console.log('📢 Emitted new-live-message to admin-monitoring room:', payload.sessionId);
  } catch (error) {
    console.error('Error emitting new live message:', error);
  }
}
function notifyActiveSessionsChanged() {
  io.to('admin-monitoring').emit('active-sessions-changed');
  console.log('🔄 Emitted active-sessions-changed to admin-monitoring room');
}

// Routes
app.get('/', (req, res) => {
  res.send('Welcome to Toolmate');
});
app.post('/add-feedback', async (req, res) => {
  try {
    const data = req.body;
    let existingFeedback = null;
    if (Array.isArray(data.email) && data.email.length > 0) {
      const query = {
        messageId: data.messageId,
        email: { $in: data.email },
        reportStatus: data.reportStatus,
      };
      existingFeedback = await feedbackStorage.findOne(query);
    }
    if (existingFeedback) {
      res.send({ message: 'Report is already added!' });
    } else {
      const result = await feedbackStorage.insertOne(data);
      if (data.reportStatus && data.feedback && data.feedback.reasons) {
        await flaggedMessagesStorage.insertOne({
          messageId: data.messageId,
          messageText: data.messageText,
          messageTimestamp: data.messageTimestamp,
          reasons: data.feedback.reasons,
          otherReason: data.feedback.otherReason || '',
          userEmail: data.email,
          isLoggedInUser: data.isLoggedInUser,
          status: 'pending',
          adminComments: '',
          flaggedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          softDeleted: false,
          archived: false,
        });
      }
      res.status(200).send(result);
    }
  } catch (err) {
    console.error('Error adding feedback:', err);
    res.status(500).send({ error: 'Failed to store feedback' });
  }
});
app.post('/store-messages', async (req, res) => {
  try {
    const data = req.body;
    const emailArray = Array.isArray(data.userEmail) ? data.userEmail : [data.userEmail];
    const existingUserMessages = await messagesStorage.findOne({
      userEmail: { $elemMatch: { $in: emailArray } },
      userName: data.userName,
    });

    let result;
    if (existingUserMessages) {
      result = await messagesStorage.updateOne(
        { _id: existingUserMessages._id },
        { $set: { messages: data.messages } }
      );
      res.send({ updated: true, result });
    } else {
      result = await messagesStorage.insertOne(data);
      res.send({ inserted: true, result });
    }
  } catch (error) {
    console.error('Error storing messages:', error);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.get('/messages/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const query = { userEmail: email };
    const result = await messagesStorage.find(query).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send(error);
  }
});

// Store and fetch suggested Tools (similar logic to messages, may not need socket events)
app.post('/store-suggested-tools', async (req, res) => {
  try {
    const data = req.body;
    const emailArray = data.userEmail;
    const existingUser = await toolsStorage.findOne({
      userEmail: { $elemMatch: { $in: emailArray } },
      userName: data.userName,
    });
    if (existingUser) {
      const result = await toolsStorage.updateOne(
        { _id: existingUser._id },
        {
          $set: {
            suggestedTools: data.suggestedTools,
          },
        }
      );
      res.send({ updated: true, result });
    } else {
      const result = await toolsStorage.insertOne(data);
      res.send({ inserted: true, result });
    }
  } catch (error) {
    console.error('Error storing suggested tools:', error);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.get('/tools/:email', async (req, res) => {
  try {
    const email = req.params.email;
    const query = { userEmail: email };
    const result = await toolsStorage.find(query).toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send(error);
  }
});

// Create or update user
app.post('/store-user', async (req, res) => {
  try {
    const { userEmail, userName, userImage, isSubscribed, role, clerkId } = req.body;
    const existingUser = await usersStorage.findOne({ userEmail });
    if (existingUser) {
      const result = await usersStorage.updateOne(
        { userEmail },
        {
          $set: {
            clerkId,
            userName,
            userImage,
            isSubscribed,
            role,
            updatedAt: new Date(),
          },
        }
      );
      res.json({ updated: true, result });
    } else {
      const userData = {
        userEmail,
        userName,
        userImage,
        isSubscribed: isSubscribed || false,
        role: role || 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
        clerkId,
      };
      const result = await usersStorage.insertOne(userData);
      res.json({ inserted: true, result });
      await emailTriggers.triggerWelcomeEmail({
        userEmail,
        userName,
        userImage,
        isSubscribed: isSubscribed || false,
        role: role || 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
        clerkId,
      });
    }
  } catch (error) {
    console.error('Error storing user:', error);
    res.status(500).json({ error: 'Failed to store user' });
  }
});

// Get user by email
app.get('/user/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const user = await usersStorage.findOne({ userEmail: email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.get('/admin/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search, role } = req.query;
    const skip = (page - 1) * limit;
    const query = {};
    if (search) {
      query.$or = [{ userName: { $regex: search, $options: 'i' } }, { userEmail: { $regex: search, $options: 'i' } }];
    }
    if (role) {
      query.role = role;
    }
    const users = await usersStorage
      .find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();
    const total = await usersStorage.countDocuments(query);
    res.json({
      users,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});
app.put('/admin/users/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const { role, isSubscribed, userEmail, userName, password, isBanned, clerkId } = req.body;
    const updateData = {
      updatedAt: new Date(),
    };
    if (role !== undefined) updateData.role = role;
    if (isSubscribed !== undefined) updateData.isSubscribed = isSubscribed;
    if (isBanned !== undefined) updateData.isBanned = isBanned;
    if (userName) updateData.userName = userName;
    if (userEmail && userEmail !== email) updateData.userEmail = userEmail;
    if (clerkId && clerkId.trim() !== '') {
      try {
        const currentClerkUser = await clerkClient.users.getUser(clerkId);
        const clerkUpdates = {};
        if (userName) {
          const nameParts = userName.split(' ');
          clerkUpdates.firstName = nameParts[0] || userName;
          clerkUpdates.lastName = nameParts.slice(1).join(' ') || '';
        }
        if (userEmail && userEmail !== email) {
          try {
            const newEmailAddress = await clerkClient.emailAddresses.createEmailAddress({
              userId: clerkId,
              emailAddress: userEmail,
              verified: true,
            });
            console.log('✅ New email address created:', newEmailAddress.id);
            await clerkClient.users.updateUser(clerkId, {
              primaryEmailAddressId: newEmailAddress.id,
            });
            const oldEmailAddresses = currentClerkUser.emailAddresses.filter((e) => e.emailAddress === email);
            for (const oldEmail of oldEmailAddresses) {
              if (oldEmail.id !== newEmailAddress.id) {
                try {
                  await clerkClient.emailAddresses.deleteEmailAddress(oldEmail.id);
                  console.log('🗑️ Deleted old email address:', oldEmail.emailAddress);
                } catch (deleteError) {
                  console.warn('⚠️ Could not delete old email:', deleteError.message);
                }
              }
            }
          } catch (emailError) {
            console.error('❌ Email update failed:', emailError);
          }
        }
        if (password) {
          try {
            await clerkClient.users.updateUser(clerkId, {
              password: password,
            });
          } catch (passwordError) {
            console.error('❌ Password update failed:', passwordError);
            throw new Error(`Password update failed: ${passwordError.message}`);
          }
        }
        if (isBanned !== undefined) {
          console.log('🚫 Attempting ban status update to:', isBanned);
          try {
            await clerkClient.users.updateUser(clerkId, {
              banned: isBanned,
            });
          } catch (banError) {
            throw new Error(`Ban status update failed: ${banError.message}`);
          }
        }
        if (Object.keys(clerkUpdates).length > 0) {
          await clerkClient.users.updateUser(clerkId, clerkUpdates);
        }
        const updatedClerkUser = await clerkClient.users.getUser(clerkId);
      } catch (clerkError) {
        console.error('❌ Clerk update error:', clerkError);
        return res.status(400).json({
          error: 'Failed to update user in Clerk',
          details: clerkError.message || clerkError.toString(),
        });
      }
    }
    const result = await usersStorage.updateOne({ userEmail: email }, { $set: updateData });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'User not found in database' });
    }
    res.json({
      message: 'User updated successfully',
      updatedFields: Object.keys(updateData),
    });
  } catch (error) {
    console.error('❌ Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});
app.put('/admin/users/:email/password', async (req, res) => {
  try {
    const { email } = req.params;
    const { password, clerkId } = req.body;
    if (!clerkId) {
      return res.status(400).json({ error: 'Clerk ID is required for password updates' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }
    try {
      const currentUser = await clerkClient.users.getUser(clerkId);
      await clerkClient.users.updateUser(clerkId, {
        password: password,
      });
      await usersStorage.updateOne(
        { userEmail: email },
        {
          $set: {
            passwordUpdatedAt: new Date(),
            updatedAt: new Date(),
          },
        }
      );
      res.json({ message: 'Password updated successfully' });
    } catch (clerkError) {
      console.error('❌ Clerk password update error:', clerkError);
      res.status(400).json({
        error: 'Failed to update password in Clerk',
        details: clerkError.message || clerkError.toString(),
      });
    }
  } catch (error) {
    console.error('❌ Error updating password:', error);
    res.status(500).json({ error: 'Failed to update password' });
  }
});
app.put('/admin/users/:email/ban', async (req, res) => {
  try {
    const { email } = req.params;
    const { banned, clerkId } = req.body;
    if (!clerkId) {
      return res.status(400).json({ error: 'Clerk ID is required for ban operations' });
    }
    if (typeof banned !== 'boolean') {
      return res.status(400).json({ error: 'Banned status must be a boolean value' });
    }
    try {
      const currentUser = await clerkClient.users.getUser(clerkId);
      await clerkClient.users.updateUser(clerkId, {
        banned: banned,
      });
      const updatedUser = await clerkClient.users.getUser(clerkId);
      const result = await usersStorage.updateOne(
        { userEmail: email },
        {
          $set: {
            isBanned: banned,
            updatedAt: new Date(),
            bannedAt: banned ? new Date() : null,
          },
        }
      );
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'User not found in database' });
      }
      res.json({
        message: `User ${banned ? 'banned' : 'unbanned'} successfully`,
        banned: banned,
      });
    } catch (clerkError) {
      console.error('❌ Clerk ban update error:', clerkError);
      res.status(400).json({
        error: 'Failed to update ban status in Clerk',
        details: clerkError.message || clerkError.toString(),
      });
    }
  } catch (error) {
    console.error('❌ Error updating ban status:', error);
    res.status(500).json({ error: 'Failed to update ban status' });
  }
});
app.get('/admin/flagged-messages', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (page - 1) * limit;
    const query = {
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
    };
    if (status && status !== 'all') {
      query.status = status.toLowerCase();
    }
    const flaggedMessages = await flaggedMessagesStorage
      .find(query)
      .sort({ flaggedAt: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();
    const total = await flaggedMessagesStorage.countDocuments(query);
    res.json({
      flaggedMessages,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching flagged messages:', error);
    res.status(500).json({ error: 'Failed to fetch flagged messages' });
  }
});
// Add cleanup job for expired messages (run this periodically)
app.post('/admin/cleanup-expired-messages', async (req, res) => {
  try {
    const now = new Date();
    const result = await flaggedMessagesStorage.deleteMany({
      expiresAt: { $lt: now },
    });
    res.json({
      message: `Cleaned up ${result.deletedCount} expired messages`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    console.error('Error cleaning up expired messages:', error);
    res.status(500).json({ error: 'Failed to cleanup expired messages' });
  }
});
app.put('/admin/flagged-messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminComments, reviewedBy } = req.body;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid message ID format' });
    }
    const currentMessage = await flaggedMessagesStorage.findOne({ _id: new ObjectId(id) });
    if (!currentMessage) {
      return res.status(404).json({ error: 'Flagged message not found' });
    }
    const validTransitions = {
      pending: ['approved', 'rejected'],
      approved: ['resolved'],
      rejected: [],
      resolved: [],
    };
    const allowedTransitions = validTransitions[currentMessage.status] || [];
    if (!allowedTransitions.includes(status)) {
      return res.status(400).json({
        error: `Invalid status transition from ${currentMessage.status} to ${status}`,
      });
    }
    if (status === 'approved' && (!adminComments || !adminComments.trim())) {
      return res.status(400).json({
        error: 'Admin comment is required when approving a message',
      });
    }
    const updateData = {
      status: status.toLowerCase(),
      adminComments,
      reviewedAt: new Date(),
      reviewedBy: reviewedBy || 'admin',
    };
    if (status === 'rejected') {
      updateData.softDeleted = true;
      updateData.softDeletedAt = new Date();
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 60);
      updateData.expiresAt = expiryDate;
    }
    if (status === 'resolved') {
      updateData.archived = true;
      updateData.archivedAt = new Date();
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() + 60);
      updateData.expiresAt = expiryDate;
    }
    const result = await flaggedMessagesStorage.updateOne({ _id: new ObjectId(id) }, { $set: updateData });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Flagged message not found' });
    }
    res.json({ message: 'Flagged message updated successfully' });
  } catch (error) {
    console.error('Error updating flagged message:', error);
    res.status(500).json({ error: 'Failed to update flagged message' });
  }
});
app.get('/admin/flagged-messages/:id/context', async (req, res) => {
  try {
    const { id } = req.params;
    const flaggedMessage = await flaggedMessagesStorage.findOne({ _id: new ObjectId(id) });
    if (!flaggedMessage) {
      return res.status(404).json({ error: 'Flagged message not found' });
    }
    let session = null;
    let user = null;
    if (flaggedMessage.userEmail) {
      const userEmailToSearch = Array.isArray(flaggedMessage.userEmail)
        ? flaggedMessage.userEmail[0]
        : flaggedMessage.userEmail;
      session = await sessionsStorage.findOne({
        $or: [
          { userEmail: userEmailToSearch },
          {
            userEmail: {
              $in: Array.isArray(flaggedMessage.userEmail) ? flaggedMessage.userEmail : [flaggedMessage.userEmail],
            },
          },
        ],
        'messages.id': flaggedMessage.messageId,
      });
      user = await usersStorage.findOne({
        $or: [
          { userEmail: userEmailToSearch },
          {
            userEmail: {
              $in: Array.isArray(flaggedMessage.userEmail) ? flaggedMessage.userEmail : [flaggedMessage.userEmail],
            },
          },
        ],
      });
    } else {
      session = await sessionsStorage.findOne({
        'messages.id': flaggedMessage.messageId,
      });
      user = null;
    }
    res.json({
      flaggedMessage,
      sessionContext: session || null,
      userDetails: user || null,
    });
  } catch (error) {
    console.error('Error fetching session context:', error);
    res.status(500).json({ error: 'Failed to fetch session context' });
  }
});
// DELETE flagged messages
app.delete('/admin/flagged-messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid message ID format' });
    }
    const result = await flaggedMessagesStorage.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Flagged message not found' });
    }
    res.json({ message: 'Flagged message deleted successfully' });
  } catch (error) {
    console.error('Error deleting flagged message:', error);
    res.status(500).json({ error: 'Failed to delete flagged message' });
  }
});
app.post('/store-session', async (req, res) => {
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
    } = req.body;

    const timestamp = new Date();

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
    };

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
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      },
    };
    if (messages && messages.length > 0 && sessionId) {
      emitNewLiveMessage({
        sessionId,
        userName,
        userEmail,
        timestamp,
        messageText: mateyResponse,
        userPrompt: prompt,
      });
    }
    const [sessionInsert, logInsert] = await Promise.all([
      sessionsStorage.insertOne(sessionData),
      chatLogsStorage.insertOne(logData),
    ]);
    notifyActiveSessionsChanged();
    res.json({
      success: true,
      sessionId: sessionInsert.insertedId,
      logId: logInsert.insertedId,
    });
  } catch (error) {
    console.error('Error storing session:', error);
    res.status(500).json({ error: 'Failed to store session' });
  }
});

// Get chat logs for admin
app.get('/admin/chat-logs', async (req, res) => {
  try {
    const { page = 1, limit = 50, search, flaggedOnly } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (search) {
      query.$or = [
        { userName: { $regex: search, $options: 'i' } },
        { prompt: { $regex: search, $options: 'i' } },
        { mateyResponse: { $regex: search, $options: 'i' } },
      ];
    }
    if (flaggedOnly === 'true') {
      query.flagTriggered = true;
    }
    const logs = await chatLogsStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();
    const total = await chatLogsStorage.countDocuments(query);
    const enrichedLogs = await Promise.all(
      logs.map(async (log) => {
        const user = await usersStorage.findOne({
          userEmail: { $in: Array.isArray(log.userEmail) ? log.userEmail : [log.userEmail] },
        });
        return {
          ...log,
          userDetails: user || null,
        };
      })
    );

    res.json({
      logs: enrichedLogs,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching chat logs:', error);
    res.status(500).json({ error: 'Failed to fetch chat logs' });
  }
});
app.get('/admin/sessions', async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (page - 1) * limit;
    const query = {};
    if (search) {
      query.$or = [{ userName: { $regex: search, $options: 'i' } }, { prompt: { $regex: search, $options: 'i' } }];
    }

    const sessions = await sessionsStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();
    const total = await sessionsStorage.countDocuments(query);
    const enrichedSessions = await Promise.all(
      sessions.map(async (session) => {
        const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail;
        const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null;
        return {
          ...session,
          userDetails: user || null,
        };
      })
    );

    res.json({
      sessions: enrichedSessions,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});
app.get('/admin/sessions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid session ID format' });
    }
    const session = await sessionsStorage.findOne({ _id: new ObjectId(id) });

    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const emailToQuery = Array.isArray(session.userEmail) ? session.userEmail[0] : session.userEmail;
    const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null;
    res.json({
      ...session,
      userDetails: user || null,
    });
  } catch (error) {
    console.error('Error fetching session:', error);
    res.status(500).json({ error: 'Failed to fetch session' });
  }
});
app.get('/admin/active-sessions', async (req, res) => {
  try {
    const fiveMinutesAgo = new Date();
    fiveMinutesAgo.setMinutes(fiveMinutesAgo.getMinutes() - 5);
    const uniqueSessions = await chatLogsStorage
      .aggregate([
        {
          $match: {
            timestamp: { $gte: fiveMinutesAgo },
          },
        },
        {
          $addFields: {
            email: {
              $cond: {
                if: { $isArray: '$userEmail' },
                then: { $arrayElemAt: ['$userEmail', 0] },
                else: '$userEmail',
              },
            },
            userAgent: '$metadata.userAgent',
            ip: '$metadata.ip',
          },
        },
        {
          $sort: { timestamp: -1 },
        },
        {
          $group: {
            _id: {
              email: '$email',
              userName: '$userName',
              userAgent: '$userAgent',
              ip: '$ip',
            },
            latestSession: { $first: '$$ROOT' },
          },
        },
        {
          $replaceRoot: { newRoot: '$latestSession' },
        },
      ])
      .toArray();
    const enrichedSessions = await Promise.all(
      uniqueSessions.map(async (session) => {
        const emailToQuery = session.userEmail?.[0] || session.userEmail;
        const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null;
        return {
          ...session,
          userDetails: user || null,
        };
      })
    );
    res.json(enrichedSessions);
  } catch (error) {
    console.error('Error fetching active sessions:', error);
    res.status(500).json({ error: 'Failed to fetch active sessions' });
  }
});

app.post('/track-redirect', async (req, res) => {
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
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    };
    await redirectTrackingStorage.insertOne(trackingData);
    res.json({ success: true });
  } catch (error) {
    console.error('Error tracking redirect:', error);
    res.status(500).json({ error: 'Failed to track redirect' });
  }
});
app.get('/admin/redirect-tracking', async (req, res) => {
  try {
    const { page = 1, limit = 50, toolId, dateFrom, dateTo } = req.query;
    const skip = (page - 1) * limit;
    const query = {};
    if (toolId) query.toolId = toolId;
    if (dateFrom || dateTo) {
      query.timestamp = {};
      if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
      if (dateTo) query.timestamp.$lte = new Date(dateTo);
    }
    const tracking = await redirectTrackingStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();
    const total = await redirectTrackingStorage.countDocuments(query);
    const clickStats = await redirectTrackingStorage
      .aggregate([
        { $match: query },
        {
          $group: {
            _id: '$toolName',
            clicks: { $sum: 1 },
            toolId: { $first: '$toolId' },
          },
        },
        { $sort: { clicks: -1 } },
      ])
      .toArray();
    res.json({
      tracking,
      clickStats,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching redirect tracking:', error);
    res.status(500).json({ error: 'Failed to fetch redirect tracking' });
  }
});
app.get('/admin/analytics', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const now = new Date();
    const startDate = new Date();
    switch (period) {
      case '24h':
        startDate.setHours(startDate.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }
    const mostFlaggedTools = await flaggedMessagesStorage
      .aggregate([
        { $match: { flaggedAt: { $gte: startDate } } },
        {
          $lookup: {
            from: 'Sessions',
            localField: 'messageId',
            foreignField: 'messages.id',
            as: 'session',
          },
        },
        { $unwind: { path: '$session', preserveNullAndEmptyArrays: true } },
        { $unwind: { path: '$session.suggestedTools', preserveNullAndEmptyArrays: true } },
        { $group: { _id: '$session.suggestedTools.name', flagCount: { $sum: 1 } } },
        { $sort: { flagCount: -1 } },
        { $limit: 10 },
      ])
      .toArray();
    const flagsByReason = await flaggedMessagesStorage
      .aggregate([
        { $match: { flaggedAt: { $gte: startDate } } },
        { $unwind: '$reasons' },
        { $group: { _id: '$reasons', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();
    const allToolsWithFlags = await flaggedMessagesStorage.distinct('messageId');
    const toolsWithNoFlags = await toolsStorage
      .aggregate([
        { $match: { 'suggestedTools.id': { $nin: allToolsWithFlags } } },
        { $unwind: '$suggestedTools' },
        { $group: { _id: '$suggestedTools.products.name', count: { $sum: 1 } } },
      ])
      .toArray();
    const totalSessions = await sessionsStorage.countDocuments({ timestamp: { $gte: startDate } });
    const totalFlags = await flaggedMessagesStorage.countDocuments({ flaggedAt: { $gte: startDate } });
    const totalRedirects = await redirectTrackingStorage.countDocuments({ timestamp: { $gte: startDate } });
    const totalUsers = await usersStorage.countDocuments({ createdAt: { $gte: startDate } });
    const subscribedUsers = await usersStorage.countDocuments({ isSubscribed: true, createdAt: { $gte: startDate } });
    res.json({
      period,
      dateRange: { start: startDate, end: now },
      statistics: { totalSessions, totalFlags, totalRedirects, totalUsers, subscribedUsers },
      mostFlaggedTools,
      flagsByReason,
      toolsWithNoFlags: toolsWithNoFlags.slice(0, 10),
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});
app.get('/admin/rag-system', async (req, res) => {
  try {
    const ragSettings = await ragSystemStorage.find({}).toArray();
    res.json(ragSettings);
  } catch (error) {
    console.error('Error fetching RAG settings:', error);
    res.status(500).json({ error: 'Failed to fetch RAG settings' });
  }
});
app.put('/admin/rag-system/tool/:id/visibility', async (req, res) => {
  try {
    const { id } = req.params;
    const { hidden, updatedBy } = req.body;
    await ragSystemStorage.updateOne(
      { id },
      { $set: { id, hidden, updatedAt: new Date(), updatedBy: updatedBy || 'admin' } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Tool visibility updated' });
  } catch (error) {
    console.error('Error updating tool visibility:', error);
    res.status(500).json({ error: 'Failed to update tool visibility' });
  }
});
app.put('/admin/rag-system/tool/:id/boost', async (req, res) => {
  try {
    const { id } = req.params;
    const { boosted, duration, updatedBy } = req.body;
    let boostExpiry = null;
    if (boosted && duration) {
      boostExpiry = new Date();
      boostExpiry.setHours(boostExpiry.getHours() + duration);
    }
    await ragSystemStorage.updateOne(
      { id },
      { $set: { id, boosted, boostExpiry, updatedAt: new Date(), updatedBy: updatedBy || 'admin' } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Tool boost updated' });
  } catch (error) {
    console.error('Error updating tool boost:', error);
    res.status(500).json({ error: 'Failed to update tool boost' });
  }
});
app.get('/rag-system/boosted-tools', async (req, res) => {
  try {
    const boostedTools = await ragSystemStorage
      .find({
        boosted: true,
        $or: [{ boostExpiry: null }, { boostExpiry: { $gt: new Date() } }],
      })
      .toArray();
    res.json(boostedTools);
  } catch (error) {
    console.error('Error fetching boosted tools:', error);
    res.status(500).json({ error: 'Failed to fetch boosted tools' });
  }
});
app.get('/rag-system/hidden-tools', async (req, res) => {
  try {
    const hiddenTools = await ragSystemStorage.find({ hidden: true }).toArray();
    res.json(hiddenTools);
  } catch (error) {
    console.error('Error fetching hidden tools:', error);
    res.status(500).json({ error: 'Failed to fetch hidden tools' });
  }
});
app.get('/rag-system/ordered-tools', async (req, res) => {
  try {
    const now = new Date();
    const tools = await ragSystemStorage.find({ hidden: { $ne: true } }).toArray();
    const boosted = [];
    const others = [];
    for (const tool of tools) {
      if (tool.boosted === true && (!tool.boostExpiry || new Date(tool.boostExpiry) > now)) {
        boosted.push(tool);
      } else {
        others.push(tool);
      }
    }
    const orderedTools = [...boosted, ...others];
    res.json(orderedTools);
  } catch (error) {
    console.error('Error fetching ordered tools:', error);
    res.status(500).json({ error: 'Failed to fetch ordered tools' });
  }
});
app.post('/api/v1/admin/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
    }
    const adminEmail = process.env.EMAIL;
    const adminPassword = process.env.PASSWORD;
    if (!adminEmail || !adminPassword) {
      return res.status(500).json({
        success: false,
        message: 'Server configuration error',
      });
    }
    if (username === adminEmail && password === adminPassword) {
      const userData = {
        username: 'Allan Davis',
        role: ['all'],
        permissions: ['all'],
        userEmail: 'help@toolmate.com',
      };
      return res.status(200).json({
        success: true,
        message: 'Login successful',
        ...userData,
      });
    } else {
      return res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
    }
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});
app.post('/shed/add', async (req, res) => {
  try {
    const { userId, toolName, category, originalPhrase, source } = req.body;
    if (!userId || !toolName) {
      return res.status(400).json({
        success: false,
        error: 'User ID and tool name are required',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    const existingTool = await shedToolsStorage.findOne({
      user_id: userId,
      tool_name: { $regex: new RegExp(`^${toolName}$`, 'i') },
      collection: { $ne: 'shed_analytics' },
    });
    if (existingTool) {
      return res.json({
        success: true,
        message: 'Tool already in shed',
        toolId: existingTool._id,
      });
    }
    const toolData = {
      user_id: userId,
      tool_name: toolName,
      category: category || 'Other',
      date_added: new Date(),
      source: source || 'chat',
      original_phrase: originalPhrase || '',
      last_updated: new Date(),
      note: '',
    };
    const result = await shedToolsStorage.insertOne(toolData);
    try {
      await shedToolsStorage.insertOne({
        collection: 'shed_analytics',
        user_id: userId,
        action: 'tool_added',
        tool_name: toolName,
        category: category || 'Other',
        timestamp: new Date(),
        source: source || 'chat',
      });
    } catch (analyticsError) {
      console.warn('Analytics insertion failed:', analyticsError);
    }
    res.json({
      success: true,
      toolId: result.insertedId,
      message: 'Tool added to shed successfully',
      tool: { ...toolData, _id: result.insertedId },
    });
  } catch (error) {
    console.error('Error adding tool to shed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.delete('/shed/remove/:toolId', async (req, res) => {
  try {
    const { toolId } = req.params;

    if (!ObjectId.isValid(toolId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid tool ID format',
      });
    }
    const toolDoc = await shedToolsStorage.findOne({
      _id: new ObjectId(toolId),
      collection: { $ne: 'shed_analytics' },
    });
    if (!toolDoc) {
      return res.status(404).json({
        success: false,
        error: 'Tool not found in shed',
      });
    }
    const result = await shedToolsStorage.deleteOne({
      _id: new ObjectId(toolId),
      collection: { $ne: 'shed_analytics' },
    });
    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tool not found or could not be deleted',
      });
    }
    try {
      await shedToolsStorage.insertOne({
        collection: 'shed_analytics',
        user_id: toolDoc.user_id,
        action: 'tool_removed',
        tool_name: toolDoc.tool_name,
        category: toolDoc.category,
        timestamp: new Date(),
        source: 'manual',
      });
    } catch (analyticsError) {
      console.warn('Analytics insertion failed:', analyticsError);
    }
    res.json({
      success: true,
      message: 'Tool removed from shed successfully',
      removedTool: toolDoc.tool_name,
    });
  } catch (error) {
    console.error('Error removing tool from shed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/shed/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const tools = await shedToolsStorage
      .find({
        user_id: userId,
        collection: { $ne: 'shed_analytics' },
      })
      .sort({ date_added: -1 })
      .toArray();
    const groupedTools = tools.reduce((acc, tool) => {
      const category = tool.category || 'Other';
      if (!acc[category]) {
        acc[category] = [];
      }
      acc[category].push(tool);
      return acc;
    }, {});
    res.json({
      success: true,
      tools: tools,
      groupedTools: groupedTools,
      totalCount: tools.length,
    });
  } catch (error) {
    console.error('Error fetching shed tools:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.put('/shed/update/:toolId', async (req, res) => {
  try {
    const { toolId } = req.params;
    const { toolName, category, note } = req.body;
    if (!ObjectId.isValid(toolId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid tool ID format',
      });
    }
    const updateData = {
      last_updated: new Date(),
    };
    if (toolName) updateData.tool_name = toolName;
    if (category) updateData.category = category;
    if (note !== undefined) updateData.note = note;
    const result = await shedToolsStorage.updateOne({ _id: new ObjectId(toolId) }, { $set: updateData });
    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tool not found in shed',
      });
    }
    const updatedTool = await shedToolsStorage.findOne({ _id: new ObjectId(toolId) });
    res.json({
      success: true,
      message: 'Tool updated successfully',
      tool: updatedTool,
    });
  } catch (error) {
    console.error('Error updating tool in shed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/shed/clear/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User ID is required',
      });
    }
    const tools = await shedToolsStorage.find({ user_id: userId }).toArray();
    const toolCount = tools.length;
    if (toolCount === 0) {
      return res.json({
        success: true,
        message: 'Shed is already empty',
        toolsRemoved: 0,
      });
    }
    const result = await shedToolsStorage.deleteMany({ user_id: userId });
    await shedToolsStorage.insertOne({
      collection: 'shed_analytics',
      user_id: userId,
      action: 'shed_cleared',
      tools_count: toolCount,
      timestamp: new Date(),
      source: 'manual',
    });

    res.json({
      success: true,
      message: 'Shed cleared successfully',
      toolsRemoved: result.deletedCount,
    });
  } catch (error) {
    console.error('Error clearing shed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post('/shed/check-ownership', async (req, res) => {
  try {
    const { userId, toolNames } = req.body;
    if (!userId || !Array.isArray(toolNames)) {
      return res.status(400).json({
        success: false,
        error: 'User ID and tool names array are required',
      });
    }
    const ownedTools = await shedToolsStorage
      .find({
        user_id: userId,
        tool_name: { $in: toolNames.map((name) => new RegExp(name, 'i')) },
      })
      .toArray();
    const ownedToolNames = ownedTools.map((tool) => tool.tool_name.toLowerCase());
    const ownership = toolNames.reduce((acc, toolName) => {
      acc[toolName] = ownedToolNames.some(
        (owned) => owned.includes(toolName.toLowerCase()) || toolName.toLowerCase().includes(owned)
      );
      return acc;
    }, {});
    res.json({
      success: true,
      ownership: ownership,
      ownedTools: ownedTools.map((tool) => ({
        id: tool._id,
        name: tool.tool_name,
        category: tool.category,
      })),
    });
  } catch (error) {
    console.error('Error checking tool ownership:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get('/admin/shed-analytics', async (req, res) => {
  try {
    const { page = 1, limit = 50, action, userId, dateFrom, dateTo } = req.query;
    const skip = (page - 1) * limit;

    const query = { collection: 'shed_analytics' };

    if (action) query.action = action;
    if (userId) query.user_id = userId;

    if (dateFrom || dateTo) {
      query.timestamp = {};
      if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
      if (dateTo) query.timestamp.$lte = new Date(dateTo);
    }

    const analytics = await shedToolsStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();
    const total = await shedToolsStorage.countDocuments(query);
    const stats = await shedToolsStorage
      .aggregate([
        { $match: { collection: 'shed_analytics' } },
        {
          $group: {
            _id: '$action',
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();
    const popularTools = await shedToolsStorage
      .aggregate([
        {
          $match: {
            collection: 'shed_analytics',
            action: 'tool_added',
          },
        },
        {
          $group: {
            _id: '$tool_name',
            count: { $sum: 1 },
            category: { $first: '$category' },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ])
      .toArray();

    res.json({
      success: true,
      analytics: analytics,
      stats: stats.reduce((acc, stat) => {
        acc[stat._id] = stat.count;
        return acc;
      }, {}),
      popularTools: popularTools,
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching shed analytics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// Get email logs for admin
app.get('/admin/email-logs', async (req, res) => {
  try {
    const { page = 1, limit = 50, type, success, recipient } = req.query;
    const skip = (page - 1) * limit;

    const query = {};
    if (type) query.type = type;
    if (success !== undefined) query.success = success === 'true';
    if (recipient) query.recipient = { $regex: recipient, $options: 'i' };

    const logs = await emailLogsStorage
      .find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number.parseInt(limit))
      .toArray();

    const total = await emailLogsStorage.countDocuments(query);

    // Get email statistics
    const stats = await emailLogsStorage
      .aggregate([
        {
          $group: {
            _id: {
              type: '$type',
              success: '$success',
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    res.json({
      logs,
      stats: stats.reduce((acc, stat) => {
        const key = `${stat._id.type}_${stat._id.success ? 'success' : 'failed'}`;
        acc[key] = stat.count;
        return acc;
      }, {}),
      pagination: {
        current: Number.parseInt(page),
        total: Math.ceil(total / limit),
        count: total,
      },
    });
  } catch (error) {
    console.error('Error fetching email logs:', error);
    res.status(500).json({ error: 'Failed to fetch email logs' });
  }
});

// Get email statistics
app.get('/admin/email-stats', async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const now = new Date();
    const startDate = new Date();

    switch (period) {
      case '24h':
        startDate.setHours(startDate.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
      default:
        startDate.setDate(startDate.getDate() - 7);
    }

    const totalEmails = await emailLogsStorage.countDocuments({
      timestamp: { $gte: startDate },
    });

    const successfulEmails = await emailLogsStorage.countDocuments({
      timestamp: { $gte: startDate },
      success: true,
    });

    const failedEmails = await emailLogsStorage.countDocuments({
      timestamp: { $gte: startDate },
      success: false,
    });

    const emailsByType = await emailLogsStorage
      .aggregate([
        { $match: { timestamp: { $gte: startDate } } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            successful: {
              $sum: { $cond: ['$success', 1, 0] },
            },
          },
        },
      ])
      .toArray();

    res.json({
      period,
      dateRange: { start: startDate, end: now },
      summary: {
        totalEmails,
        successfulEmails,
        failedEmails,
        successRate: totalEmails > 0 ? ((successfulEmails / totalEmails) * 100).toFixed(2) : 0,
      },
      emailsByType,
    });
  } catch (error) {
    console.error('Error fetching email statistics:', error);
    res.status(500).json({ error: 'Failed to fetch email statistics' });
  }
});

// Resend failed email
app.post('/admin/email-logs/:id/resend', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid email log ID format' });
    }

    const emailLog = await emailLogsStorage.findOne({ _id: new ObjectId(id) });

    if (!emailLog) {
      return res.status(404).json({ error: 'Email log not found' });
    }

    if (emailLog.success) {
      return res.status(400).json({ error: 'Cannot resend successful email' });
    }

    // Resend based on email type
    let result;
    switch (emailLog.type) {
      case 'welcome':
        result = await emailService.sendWelcomeEmail(emailLog.recipient, emailLog.recipientName);
        break;
      case 'password_reset_success':
        result = await emailService.sendPasswordResetSuccessEmail(emailLog.recipient, emailLog.recipientName);
        break;
      case 'system_alert':
        result = await emailService.sendSystemAlertEmail(
          emailLog.recipient,
          emailLog.recipientName,
          emailLog.subType,
          emailLog.message
        );
        break;
      default:
        return res.status(400).json({ error: 'Unknown email type for resend' });
    }

    res.json({
      message: 'Email resend attempted',
      success: result.success,
      originalLogId: id,
    });
  } catch (error) {
    console.error('Error resending email:', error);
    res.status(500).json({ error: 'Failed to resend email' });
  }
});
// Get shed statistics for admin dashboard
app.get('/admin/shed-stats', async (req, res) => {
  try {
    const totalTools = await shedToolsStorage.countDocuments({
      collection: { $ne: 'shed_analytics' },
    });

    const totalUsers = await shedToolsStorage.distinct('user_id', {
      collection: { $ne: 'shed_analytics' },
    });

    const categoryStats = await shedToolsStorage
      .aggregate([
        { $match: { collection: { $ne: 'shed_analytics' } } },
        {
          $group: {
            _id: '$category',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
      ])
      .toArray();
    const averageToolsPerUser = totalUsers.length > 0 ? totalTools / totalUsers.length : 0;
    res.json({
      success: true,
      stats: {
        totalTools: totalTools,
        totalUsersWithTools: totalUsers.length,
        averageToolsPerUser: Math.round(averageToolsPerUser * 100) / 100,
        categoryBreakdown: categoryStats,
      },
    });
  } catch (error) {
    console.error('Error fetching shed statistics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
// Bulk add tools to shed (for migration or admin purposes)
app.post('/shed/bulk-add', async (req, res) => {
  try {
    const { userId, tools } = req.body;

    if (!userId || !Array.isArray(tools) || tools.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'User ID and tools array are required',
      });
    }

    const toolsToInsert = tools.map((tool) => ({
      user_id: userId,
      tool_name: tool.name || tool.toolName,
      category: tool.category || 'Other',
      date_added: new Date(),
      source: tool.source || 'bulk_import',
      original_phrase: tool.originalPhrase || '',
      last_updated: new Date(),
      note: tool.note || '',
    }));
    const result = await shedToolsStorage.insertMany(toolsToInsert);
    // Log analytics
    await shedToolsStorage.insertOne({
      collection: 'shed_analytics',
      user_id: userId,
      action: 'bulk_import',
      tools_count: toolsToInsert.length,
      timestamp: new Date(),
      source: 'admin',
    });
    res.json({
      success: true,
      message: `${result.insertedCount} tools added to shed successfully`,
      insertedCount: result.insertedCount,
      toolIds: result.insertedIds,
    });
  } catch (error) {
    console.error('Error bulk adding tools to shed:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
app.use((req, res) => {
  res.status(404).send({ error: 'Not Found' });
});
app.use((err, req, res, next) => {
  console.error('Global error handler:', err.stack);
  res.status(500).send({ error: 'Something went wrong!' });
});
