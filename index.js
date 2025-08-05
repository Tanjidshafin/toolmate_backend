require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClerkClient } = require('@clerk/clerk-sdk-node');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const EmailService = require('./services/emailService');
const EmailTriggers = require('./services/emailTriggers');
const AuditLogger = require('./services/auditLogs');
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
// Import route modules
const feedbackRoutes = require('./services/feedback-routes');
const messageRoutes = require('./services/message-routes');
const toolRoutes = require('./services/tool-routes');
const userRoutes = require('./services/user-routes');
const flaggedMessageRoutes = require('./services/flagged-message-routes');
const sessionRoutes = require('./services/session-routes');
const redirectTrackingRoutes = require('./services/redirect-tracking-routes');
const analyticsRoutes = require('./services/analytics-routes');
const ragSystemRoutes = require('./services/rag-system-routes');
const adminAuthRoutes = require('./services/admin-auth-routes');
const shedToolRoutes = require('./services/shed-tool-routes');
const emailLogRoutes = require('./services/email-log-routes');
const auditLogRoutes = require('./services/audit-log-routes');
const jobLogsRoutes = require('./services/job-logs-routes');
const subscriptionRoutes = require('./services/subscription-routes');
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
let auditLogsStorage;
let jobLogsStorage;
let subscriptionStorage;
let adminCredentialsStorage;
let emailService;
let emailTriggers;
let auditLogger;
let clerkClient;
async function run() {
  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('✅ Connected to MongoDB!');
    // Initialize MongoDB collections
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
    auditLogsStorage = client.db('Toolmate').collection('AuditLogs');
    jobLogsStorage = client.db('Toolmate').collection('JobLogs');
    adminCredentialsStorage = client.db('Toolmate').collection('AdminCredentials');
    subscriptionStorage = client.db('Toolmate').collection('Subscriptions');
    emailService = new EmailService(emailLogsStorage);
    emailTriggers = new EmailTriggers(emailService);
    auditLogger = new AuditLogger(auditLogsStorage);
    clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    function getUserInfoFromRequest(req) {
      return {
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.headers['user-agent'],
      };
    }
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
          const recentSession = await chatLogsStorage.findOne(
            { sessionId: data.sessionId },
            { sort: { timestamp: -1 } }
          );
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
          // Log audit for message injection
          await auditLogger.logAudit({
            action: 'INJECT_MESSAGE',
            resource: 'session',
            resourceId: data.sessionId,
            userId: 'admin',
            userEmail: 'admin@toolmate.com',
            role: 'admin',
            newData: {
              message: data.message,
              targetSession: data.sessionId,
              targetUser: userDetails?.userEmail || 'Unknown',
            },
            metadata: {
              socketId: socket.id,
              targetUserName: userDetails?.userName || 'Unknown User',
            },
          });

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
    const routeDependencies = {
      feedbackStorage,
      messagesStorage,
      toolsStorage,
      usersStorage,
      flaggedMessagesStorage,
      sessionsStorage,
      redirectTrackingStorage,
      ragSystemStorage,
      chatLogsStorage,
      shedToolsStorage,
      emailLogsStorage,
      auditLogsStorage,
      jobLogsStorage,
      adminCredentialsStorage,
      emailService,
      emailTriggers,
      auditLogger,
      clerkClient,
      ObjectId,
      subscriptionStorage,
      getUserInfoFromRequest,
      emitNewLiveMessage,
      notifyActiveSessionsChanged,
      io,
    };
    app.get('/', (req, res) => {
      res.send('Welcome to Toolmate');
    });
    app.use('/', feedbackRoutes(routeDependencies));
    app.use('/', messageRoutes(routeDependencies));
    app.use('/', toolRoutes(routeDependencies));
    app.use('/', userRoutes(routeDependencies));
    app.use('/', flaggedMessageRoutes(routeDependencies));
    app.use('/', sessionRoutes(routeDependencies));
    app.use('/', redirectTrackingRoutes(routeDependencies));
    app.use('/', analyticsRoutes(routeDependencies));
    app.use('/', ragSystemRoutes(routeDependencies));
    app.use('/', adminAuthRoutes(routeDependencies));
    app.use('/', shedToolRoutes(routeDependencies));
    app.use('/', emailLogRoutes(routeDependencies));
    app.use('/', auditLogRoutes(routeDependencies));
    app.use('/', jobLogsRoutes(routeDependencies));
    app.use('/', subscriptionRoutes(routeDependencies));
    // Error handling middleware
    app.use((req, res) => {
      res.status(404).send({ error: 'Not Found' });
    });

    app.use((err, req, res, next) => {
      console.error('Global error handler:', err.stack);
      res.status(500).send({ error: 'Something went wrong!' });
    });

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
