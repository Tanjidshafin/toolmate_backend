require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClerkClient } = require('@clerk/clerk-sdk-node');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const OpenAI = require('openai');
const EmailService = require('./services/emailService');
const EmailTriggers = require('./services/emailTriggers');
const AuditLogger = require('./services/auditLogs');
const cron = require('node-cron');
const app = express();
const PORT = process.env.PORT || 5000;
const { Server } = require('socket.io');
const http = require('http');
const { randomUUID } = require('crypto');
const server = http.createServer(app);
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingInterval: 30000,
  pingTimeout: 5000,
});
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
const blogRoutes = require('./services/blogs-route');
const subscriptionRoutes = require('./services/subscription-routes');
const storeLocationRoutes = require('./services/store-location');
const testimonialsRoutes = require('./services/testimonials-routes');
const { reconcileSubscriptionState } = require('./services/subscription-reconciliation');

const validateStripeEnv = () => {
  const missing = [];

  if (!process.env.STRIPE_SECRET_KEY) {
    missing.push('STRIPE_SECRET_KEY');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    missing.push('STRIPE_WEBHOOK_SECRET');
  }

  if (!(process.env.STRIPE_PRICE_ID_BEST_MATES_RECURRING || process.env.STRIPE_PRICE_ID_BEST_MATES)) {
    missing.push('STRIPE_PRICE_ID_BEST_MATES_RECURRING (or STRIPE_PRICE_ID_BEST_MATES)');
  }

  if (missing.length > 0) {
    throw new Error(`Missing required Stripe environment variables: ${missing.join(', ')}`);
  }
};

const SUBSCRIPTION_RECONCILIATION_CRON = process.env.SUBSCRIPTION_RECONCILIATION_CRON || '0 * * * *';

app.use(cors());
app.use(
  express.json({
    limit: '50mb',
    verify: (req, res, buf) => {
      if (req.originalUrl === '/api/webhooks/stripe') {
        req.rawBody = buf;
      }
    },
  }),
);
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
let blogsStorage;
let storeLocationStorage;
let subscriptionStorage;
let adminCredentialsStorage;
let toolAnalyticsStorage;
let promoStorage;
let devTestOverrideStorage;
let testimonialsStorage;
let emailService;
let emailTriggers;
let auditLogger;
let clerkClient;
async function run() {
  try {
    validateStripeEnv();

    await client.connect();
    await client.db('admin').command({ ping: 1 });
    console.log('Connected to MongoDB!');
    feedbackStorage = client.db('Toolmate').collection('Feedbacks');
    messagesStorage = client.db('Toolmate').collection('Messages');
    toolsStorage = client.db('Toolmate').collection('Tools');
    usersStorage = client.db('Toolmate').collection('Users');
    flaggedMessagesStorage = client.db('Toolmate').collection('FlaggedMessages');
    sessionsStorage = client.db('Toolmate').collection('Sessions');
    redirectTrackingStorage = client.db('Toolmate').collection('RedirectTracking');
    ragSystemStorage = client.db('Toolmate').collection('RagTools');
    chatLogsStorage = client.db('Toolmate').collection('ChatLogsStorage');
    shedToolsStorage = client.db('Toolmate').collection('ShedTools');
    emailLogsStorage = client.db('Toolmate').collection('EmailLogs');
    auditLogsStorage = client.db('Toolmate').collection('AuditLogs');
    jobLogsStorage = client.db('Toolmate').collection('JobLogs');
    blogsStorage = client.db('Toolmate').collection('Blogs');
    adminCredentialsStorage = client.db('Toolmate').collection('AdminCredentials');
    subscriptionStorage = client.db('Toolmate').collection('Subscriptions');
    toolAnalyticsStorage = client.db('Toolmate').collection('ToolAnalytics');
    promoStorage = client.db('Toolmate').collection('Promos');
    devTestOverrideStorage = client.db('Toolmate').collection('DevTestOverrides');
    storeLocationStorage = client.db('Toolmate').collection('StoreLocations');
    testimonialsStorage = client.db('Toolmate').collection('Testimonials');

    await Promise.all([
      sessionsStorage.createIndex({ timestamp: -1, sessionId: 1, userEmail: 1 }),
      sessionsStorage.createIndex({ sessionId: 1, userEmail: 1 }),
      testimonialsStorage.createIndex({ isVisible: 1, createdAt: -1 }),
      testimonialsStorage.createIndex({ deletedAt: 1, createdAt: -1 }),
      testimonialsStorage.createIndex({ status: 1, createdAt: -1 }),
      testimonialsStorage.createIndex({ userEmail: 1, deletedAt: 1, status: 1 }),
      testimonialsStorage.createIndex({ guestToken: 1, deletedAt: 1, status: 1 }),
    ]);
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
      socket.on('join-monitoring', (data) => {
        socket.join('admin-monitoring');
      });

      socket.on('join-boost-monitoring', (data) => {
        socket.join('boost-monitoring');
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
            { sort: { timestamp: -1 } },
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
      socket.on('product-updated', async (data) => {
        try {
          io.to('admin-monitoring').emit('product-reindexed', {
            toolId: data.toolId,
            timestamp: new Date(),
            updateType: data.updateType,
          });
          console.log(`Product ${data.toolId} reindexed instantly`);
        } catch (error) {
          console.error('Error handling product update:', error);
        }
      });

      socket.on('boost-timer-expired', async (data) => {
        try {
          console.log(`Boost timer expired for tool: ${data.toolName} (${data.toolId})`);
          await ragSystemStorage.updateOne(
            { id: data.toolId },
            {
              $set: {
                boosted: false,
                boostExpiry: null,
                updatedAt: new Date(),
                updatedBy: 'system-timer-expired',
              },
            },
          );

          io.to('admin-monitoring').emit('boost-timer-expired-notification', {
            toolId: data.toolId,
            toolName: data.toolName,
            timestamp: new Date(),
            message: `TIME UP! Boost expired for "${data.toolName}"`,
            type: 'timer-expired',
          });

          io.emit('boost-expired-global', {
            toolId: data.toolId,
            toolName: data.toolName,
            timestamp: new Date(),
            message: `Boost timer expired for "${data.toolName}"`,
          });
          await auditLogger.logAudit({
            action: 'BOOST_TIMER_EXPIRED',
            resource: 'rag_tool_boost',
            resourceId: data.toolId,
            userId: 'system',
            userEmail: 'system@toolmate.com',
            role: 'system',
            metadata: {
              toolId: data.toolId,
              toolName: data.toolName,
              expiredAt: new Date(),
              triggeredByClient: true,
            },
          });
        } catch (error) {
          console.error('Error handling boost timer expired:', error);
        }
      });
      socket.on('disconnect', (reason) => {
        console.log('Admin disconnected from monitoring:', socket.id, 'Reason:', reason);
      });
    });
    cron.schedule('*/1 * * * *', async () => {
      try {
        const now = new Date();
        const todayDateString = now.toDateString();
        const usersNeedingReset = await usersStorage
          .find({
            $or: [{ lastLimitReset: { $ne: todayDateString } }, { lastLimitReset: { $exists: false } }],
          })
          .toArray();
        if (usersNeedingReset.length > 0) {
          await usersStorage.updateMany(
            {
              $or: [{ lastLimitReset: { $ne: todayDateString } }, { lastLimitReset: { $exists: false } }],
            },
            {
              $set: {
                dailyMessageCount: 0,
                dailyImageUploadCount: 0,
                lastLimitReset: todayDateString,
                updatedAt: now,
              },
            },
          );
          for (const user of usersNeedingReset) {
            await auditLogger.logAudit({
              action: 'DAILY_LIMIT_RESET',
              resource: 'user_limits',
              resourceId: user._id.toString(),
              userId: 'system',
              userEmail: 'system@toolmate.com',
              role: 'system',
              oldData: {
                dailyMessageCount: user.dailyMessageCount || 0,
                dailyImageUploadCount: user.dailyImageUploadCount || 0,
                lastLimitReset: user.lastLimitReset,
              },
              newData: {
                dailyMessageCount: 0,
                dailyImageUploadCount: 0,
                lastLimitReset: todayDateString,
              },
              metadata: {
                userEmail: user.userEmail,
                automaticReset: true,
                resetAt: now,
              },
            });
          }
          io.to('admin-monitoring').emit('daily-limits-reset', {
            resetUsers: usersNeedingReset.map((u) => ({
              email: u.userEmail,
              name: u.userName || 'Unknown',
            })),
            timestamp: now,
            count: usersNeedingReset.length,
          });
        }
      } catch (error) {
        console.error('Error in daily limit reset cron job:', error);
      }
    });
    cron.schedule(SUBSCRIPTION_RECONCILIATION_CRON, async () => {
      try {
        const summary = await reconcileSubscriptionState({
          usersStorage,
          subscriptionStorage,
          auditLogger,
        });
      } catch (error) {
        console.error('Error in subscription reconciliation cron job:', error);
      }
    });
    cron.schedule('*/1 * * * *', async () => {
      try {
        const now = new Date();
        const expiredBoosts = await ragSystemStorage
          .find({
            boosted: true,
            boostExpiry: { $lte: now },
          })
          .toArray();
        if (expiredBoosts.length > 0) {
          await ragSystemStorage.updateMany(
            { boosted: true, boostExpiry: { $lte: now } },
            {
              $set: {
                boosted: false,
                boostExpiry: null,
                updatedAt: now,
                updatedBy: 'system-cron',
              },
            },
          );
          for (const tool of expiredBoosts) {
            await auditLogger.logAudit({
              action: 'BOOST_EXPIRED',
              resource: 'rag_tool_boost',
              resourceId: tool.id,
              userId: 'system',
              userEmail: 'system@toolmate.com',
              role: 'system',
              oldData: { boosted: true, boostExpiry: tool.boostExpiry },
              newData: { boosted: false, boostExpiry: null },
              metadata: {
                toolId: tool.id,
                expiredAt: now,
                automaticExpiry: true,
              },
            });
          }
          io.to('admin-monitoring').emit('boost-expired', {
            expiredTools: expiredBoosts.map((t) => ({ id: t.id, name: t.name })),
            timestamp: now,
          });

          io.emit('boost-expired-global', {
            expiredTools: expiredBoosts.map((t) => ({ id: t.id, name: t.name })),
            timestamp: now,
            message: `${expiredBoosts.length} tool boost(s) have expired`,
          });

          console.log(`Expired ${expiredBoosts.length} tool boosts`);
        }
      } catch (error) {
        console.error('Error in boost expiry cron job:', error);
      }
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
          id:
            messageData.messageId ||
            `${messageData.sessionId}-${Date.now()}-${typeof randomUUID === 'function' ? randomUUID() : Math.random().toString(36).slice(2, 10)}`,
          sessionId: messageData.sessionId,
          userName: messageData.userName || (userDetails ? userDetails.userName : 'Unknown User'),
          userEmail: messageData.userEmail || (userDetails ? userDetails.userEmail : 'N/A'),
          userImage: userDetails ? userDetails.userImage : null,
          timestamp: messageData.timestamp || new Date(),
          messageText: messageData.messageText,
          prompt: messageData.userPrompt,
          partIndex: messageData.partIndex,
          totalParts: messageData.totalParts,
          responseGroupId: messageData.responseGroupId,
        };
        await toolAnalyticsStorage.insertOne({
          type: 'message',
          sessionId: messageData.sessionId,
          userEmail: payload.userEmail,
          timestamp: new Date(),
          metadata: {
            messageLength: messageData.messageText?.length || 0,
            hasPrompt: !!messageData.userPrompt,
          },
        });
        io.to('admin-monitoring').emit('new-live-message', payload);
      } catch (error) {
        console.error('Error emitting new live message:', error);
      }
    }
    function notifyActiveSessionsChanged() {
      io.to('admin-monitoring').emit('active-sessions-changed');
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
      toolAnalyticsStorage,
      promoStorage,
      devTestOverrideStorage,
      testimonialsStorage,
      getUserInfoFromRequest,
      emitNewLiveMessage,
      blogsStorage,
      storeLocationStorage,
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
    app.use('/', blogRoutes(routeDependencies));
    app.use('/', storeLocationRoutes(routeDependencies));
    app.use('/', testimonialsRoutes(routeDependencies));
    app.use((req, res) => {
      res.status(404).send({ error: 'Not Found' });
    });
    app.use((err, req, res, next) => {
      console.error('Global error handler:', err.stack);
      res.status(500).send({ error: 'Something went wrong!' });
    });
    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`Socket.io server is ready`);
    });
  } catch (err) {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  }
}

run();
