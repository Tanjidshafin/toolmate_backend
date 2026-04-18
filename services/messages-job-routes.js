const express = require('express');
const { ObjectId } = require('mongodb');
const { createChatRateLimiter } = require('./chat-rate-limit');

// Single source of truth for cursor pagination across the stack. The React app and the
// admin dashboard both import this (via the client-side mirror) so changing it here changes
// "Load more" batch size everywhere.
const CURSOR_DATA_SIZE = 5;
const DEFAULT_PAGE_SIZE = CURSOR_DATA_SIZE;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TITLE = 'New Chat';

const hasMessageContent = (value) => typeof value === 'string' && value.trim().length > 0;
const isMeaningfulText = (value) => typeof value === 'string' && value.trim().length > 8;

const buildSessionTitle = (content) => {
  if (!isMeaningfulText(content)) {
    return null;
  }
  const sanitized = content.replace(/\s+/g, ' ').trim();
  const firstSentence = sanitized.split(/[.!?\n]/)[0]?.trim();
  const titleSource = firstSentence || sanitized;
  return titleSource.slice(0, 80);
};

const normalizeRole = (role) => {
  if (role === 'matey' || role === 'assistant') {
    return 'matey';
  }
  return 'user';
};

const normalizeArray = (value) => (Array.isArray(value) ? value : []);

const encodeCursor = (message) => {
  const payload = {
    createdAt: new Date(message.createdAt).toISOString(),
    id: message._id.toString(),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
};

const decodeCursor = (cursor) => {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed?.createdAt || !parsed?.id || !ObjectId.isValid(parsed.id)) {
      return null;
    }
    const date = new Date(parsed.createdAt);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return {
      createdAt: date,
      id: new ObjectId(parsed.id),
    };
  } catch (error) {
    return null;
  }
};

const computeIsToolSuggestion = (doc) => {
  if (typeof doc?.isToolSuggestion === 'boolean') return doc.isToolSuggestion;
  const meta = doc?.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  if (meta.isToolSuggestion === true) return true;
  const tools = normalizeArray(doc?.suggestedTools);
  return tools.length > 0;
};

const toPublicMessage = (doc) => {
  if (!doc) return doc;
  return {
    id: doc._id ? doc._id.toString() : doc.id,
    serverMessageId: doc._id ? doc._id.toString() : null,
    clientMessageId: doc.clientMessageId || null,
    sessionId: doc.sessionId,
    userId: doc.userId || null,
    userEmail: doc.userEmail || null,
    role: doc.role,
    content: typeof doc.content === 'string' ? doc.content : '',
    images: normalizeArray(doc.images),
    suggestedTools: normalizeArray(doc.suggestedTools),
    toolsUsed: normalizeArray(doc.toolsUsed),
    // Top-level boolean so clients don't have to dig into metadata; backfilled for legacy rows.
    isToolSuggestion: computeIsToolSuggestion(doc),
    metadata: doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {},
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

module.exports = ({
  mongoClient,
  messagesJobStorage,
  mateyChatSessionsStorage,
  usersStorage,
  chatLogsStorage,
  auditLogger,
  getUserInfoFromRequest,
  emitNewLiveMessage,
  notifyActiveSessionsChanged,
}) => {
  const router = express.Router();

  const normalizeEmailValue = (email) => {
    if (Array.isArray(email)) {
      return email[0] || null;
    }
    return email || null;
  };

  const chatLimiter = createChatRateLimiter({
    perMinute: Number.parseInt(process.env.CHAT_RATE_PER_MINUTE, 10) || 120,
    perDay: Number.parseInt(process.env.CHAT_RATE_PER_DAY, 10) || 500,
    imagePerDay: Number.parseInt(process.env.CHAT_IMAGE_PER_DAY, 10) || 25,
  });

  // Session counters and title are kept strictly consistent with every message write.
  // We use a Mongo transaction when the deployment is a replica set; otherwise we fall back
  // to ordered writes so local (standalone) environments still work.
  const supportsTransactions = () => {
    return !!(mongoClient && typeof mongoClient.startSession === 'function' && process.env.MONGO_TRANSACTIONS !== 'false');
  };

  const persistMessageAtomic = async ({ messageDoc, sessionDelta }) => {
    const { sessionId } = messageDoc;
    const now = messageDoc.createdAt;

    const incomingTitle = sessionDelta.titleCandidate;

    // MongoDB rejects the same path in both $setOnInsert and $inc. Counters are omitted from
    // $setOnInsert because $inc on an upsert initializes missing fields to 0 + delta, which is
    // exactly what we want for a freshly created session document.
    const sessionUpdate = {
      $setOnInsert: {
        sessionId,
        title: incomingTitle || DEFAULT_TITLE,
        createdAt: now,
      },
      $set: {
        updatedAt: now,
        lastMessageAt: now,
        ...(sessionDelta.userId ? { userId: sessionDelta.userId } : {}),
        ...(sessionDelta.userEmail ? { userEmail: sessionDelta.userEmail } : {}),
        ...(sessionDelta.userName ? { userName: sessionDelta.userName } : {}),
      },
      $inc: {
        messageCount: 1,
        userMessageCount: messageDoc.role === 'user' ? 1 : 0,
        mateyMessageCount: messageDoc.role === 'matey' ? 1 : 0,
      },
    };

    if (incomingTitle) {
      // Only set title when current value is still the default. Concurrent writers stay safe
      // because $set happens on the default branch only.
      await mateyChatSessionsStorage.updateOne(
        { sessionId, title: DEFAULT_TITLE },
        { $set: { title: incomingTitle } },
      );
    }

    if (supportsTransactions()) {
      const session = mongoClient.startSession();
      try {
        let inserted;
        await session.withTransaction(async () => {
          const insertResult = await messagesJobStorage.insertOne(messageDoc, { session });
          inserted = insertResult;
          await mateyChatSessionsStorage.updateOne({ sessionId }, sessionUpdate, {
            upsert: true,
            session,
          });
        });
        return inserted;
      } finally {
        await session.endSession();
      }
    }

    const insertResult = await messagesJobStorage.insertOne(messageDoc);
    await mateyChatSessionsStorage.updateOne({ sessionId }, sessionUpdate, { upsert: true });
    return insertResult;
  };

  router.post('/chat/session/init', async (req, res) => {
    try {
      const {
        sessionId,
        userId = null,
        userEmail = null,
        userName = 'Anonymous',
      } = req.body || {};

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const now = new Date();

      await mateyChatSessionsStorage.updateOne(
        { sessionId },
        {
          $setOnInsert: {
            sessionId,
            title: DEFAULT_TITLE,
            createdAt: now,
            messageCount: 0,
            userMessageCount: 0,
            mateyMessageCount: 0,
            ...(userId ? { userId } : {}),
          },
          $set: {
            updatedAt: now,
            ...(userId ? { userId } : {}),
            ...(userEmail ? { userEmail } : {}),
            ...(userName ? { userName } : {}),
          },
        },
        { upsert: true },
      );

      return res.json({ success: true, sessionId });
    } catch (error) {
      console.error('Error initializing chat session:', error);
      return res.status(500).json({ error: 'Failed to initialize session' });
    }
  });

  router.post('/chat/messages', chatLimiter, async (req, res) => {
    try {
      const {
        sessionId,
        userId = null,
        userEmail = null,
        userName = 'Anonymous',
        role,
        content,
        images = [],
        suggestedTools = [],
        toolsUsed = [],
        metadata = {},
        clientMessageId = null,
      } = req.body || {};

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const normalizedImages = normalizeArray(images);
      if (!hasMessageContent(content) && normalizedImages.length === 0) {
        return res.status(400).json({ error: 'content or images are required' });
      }

      const normalizedRole = normalizeRole(role);
      const now = new Date();

      // Idempotency: reuse the stored row when the client retries with the same clientMessageId.
      if (clientMessageId) {
        const existing = await messagesJobStorage.findOne({ sessionId, clientMessageId });
        if (existing) {
          return res.json({
            success: true,
            duplicate: true,
            message: toPublicMessage(existing),
          });
        }
      }

      const normalizedMetadata = metadata && typeof metadata === 'object' ? metadata : {};
      const normalizedSuggestedTools = normalizeArray(suggestedTools);
      const isToolSuggestion =
        normalizedMetadata.isToolSuggestion === true || normalizedSuggestedTools.length > 0;

      const messageDoc = {
        sessionId,
        userId,
        userEmail,
        role: normalizedRole,
        content: typeof content === 'string' ? content : '',
        images: normalizedImages,
        suggestedTools: normalizedSuggestedTools,
        toolsUsed: normalizeArray(toolsUsed),
        // First-class chat data: tool rows are flagged at the top level so queries and the
        // admin dashboard don't need to peek into metadata.
        isToolSuggestion,
        metadata: normalizedMetadata,
        clientMessageId,
        createdAt: now,
        updatedAt: now,
      };

      const titleCandidate = normalizedRole === 'matey' ? buildSessionTitle(content) : null;

      let insertResult;
      try {
        insertResult = await persistMessageAtomic({
          messageDoc,
          sessionDelta: {
            userId,
            userEmail,
            userName,
            titleCandidate,
          },
        });
      } catch (insertErr) {
        // Race: two concurrent POSTs with the same clientMessageId can both pass findOne(null).
        const isDup =
          insertErr?.code === 11000 ||
          insertErr?.codeName === 'DuplicateKey' ||
          insertErr?.message?.includes('E11000');
        if (isDup && clientMessageId) {
          const existing = await messagesJobStorage.findOne({ sessionId, clientMessageId });
          if (existing) {
            return res.json({
              success: true,
              duplicate: true,
              message: toPublicMessage(existing),
            });
          }
        }
        throw insertErr;
      }

      const savedMessage = { ...messageDoc, _id: insertResult.insertedId };

      // Best-effort legacy dual-write: keep admin job-history (ChatLogs) functional during cutover.
      // A matey message finalises a (user, matey) pair so we emit the live event and append
      // a ChatLogs row when possible.
      try {
        if (normalizedRole === 'matey' && chatLogsStorage) {
          const recentUser = await messagesJobStorage
            .find({ sessionId, role: 'user' })
            .sort({ createdAt: -1, _id: -1 })
            .limit(1)
            .toArray();
          const latestPrompt = recentUser[0]?.content || '';

          await chatLogsStorage.insertOne({
            sessionId,
            userId,
            userEmail,
            userName,
            prompt: latestPrompt,
            mateyResponse: messageDoc.content,
            suggestedTools: messageDoc.suggestedTools,
            toolsUsed: messageDoc.toolsUsed,
            timestamp: now,
            metadata: {
              userAgent: req.headers['user-agent'],
              ip: req.ip,
              clientMessageId,
              source: 'chat/messages',
            },
          });

          if (typeof emitNewLiveMessage === 'function') {
            emitNewLiveMessage({
              messageId: savedMessage._id.toString(),
              sessionId,
              userName,
              userEmail,
              timestamp: now,
              messageText: messageDoc.content,
              userPrompt: latestPrompt,
            });
          }
        }
        if (typeof notifyActiveSessionsChanged === 'function') {
          notifyActiveSessionsChanged();
        }
      } catch (dualWriteError) {
        console.error('Legacy ChatLogs dual-write failed (non-fatal):', dualWriteError);
      }

      try {
        await auditLogger.logAudit({
          action: 'CREATE',
          resource: 'messages_job',
          resourceId: savedMessage._id.toString(),
          userId: userId || userEmail || 'anonymous',
          userEmail: userEmail || 'anonymous@toolmate.com',
          role: 'user',
          newData: {
            sessionId,
            role: normalizedRole,
            contentLength: typeof content === 'string' ? content.length : 0,
            imagesCount: normalizedImages.length,
            suggestedToolsCount: messageDoc.suggestedTools.length,
            toolsUsedCount: messageDoc.toolsUsed.length,
          },
          ...getUserInfoFromRequest(req),
        });
      } catch (auditError) {
        console.error('Audit log failed (non-fatal):', auditError);
      }

      return res.json({ success: true, message: toPublicMessage(savedMessage) });
    } catch (error) {
      console.error('Error storing chat message:', error);
      return res.status(500).json({ error: 'Failed to store message' });
    }
  });

  router.get('/chat/messages', async (req, res) => {
    try {
      const { sessionId, cursor, limit = DEFAULT_PAGE_SIZE } = req.query;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const pageSize = Math.min(
        Math.max(Number.parseInt(limit, 10) || DEFAULT_PAGE_SIZE, 1),
        MAX_PAGE_SIZE,
      );
      const cursorValue = cursor ? decodeCursor(cursor) : null;

      const query = { sessionId };
      if (cursorValue) {
        query.$or = [
          { createdAt: { $lt: cursorValue.createdAt } },
          { createdAt: cursorValue.createdAt, _id: { $lt: cursorValue.id } },
        ];
      }

      const rows = await messagesJobStorage
        .find(query)
        .sort({ createdAt: -1, _id: -1 })
        .limit(pageSize + 1)
        .toArray();

      const hasMore = rows.length > pageSize;
      const sliced = hasMore ? rows.slice(0, pageSize) : rows;
      const nextCursor = hasMore ? encodeCursor(sliced[sliced.length - 1]) : null;

      return res.json({
        success: true,
        sessionId,
        messages: sliced.reverse().map(toPublicMessage),
        pagination: {
          hasMore,
          nextCursor,
          limit: pageSize,
        },
      });
    } catch (error) {
      console.error('Error fetching chat messages:', error);
      return res.status(500).json({ error: 'Failed to fetch messages' });
    }
  });

  router.get('/chat/sessions', async (req, res) => {
    try {
      const { userEmail, userId, sessionId, limit = 20 } = req.query;
      const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);

      let query = { messageCount: { $gt: 0 } };

      if (sessionId) {
        query = { sessionId, messageCount: { $gt: 0 } };
      } else if (userId) {
        query = {
          messageCount: { $gt: 0 },
          $or: [{ userId }, ...(userEmail ? [{ userEmail }] : [])],
        };
      } else if (userEmail) {
        query = { messageCount: { $gt: 0 }, userEmail };
      } else {
        return res.status(400).json({ error: 'Provide sessionId or user identity' });
      }

      const sessions = await mateyChatSessionsStorage
        .find(query)
        .project({
          sessionId: 1,
          title: 1,
          messageCount: 1,
          userMessageCount: 1,
          mateyMessageCount: 1,
          createdAt: 1,
          updatedAt: 1,
          lastMessageAt: 1,
          userEmail: 1,
          userId: 1,
        })
        .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
        .limit(pageSize)
        .toArray();

      return res.json({ success: true, sessions });
    } catch (error) {
      console.error('Error fetching chat sessions:', error);
      return res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  // One-shot hydration used by the React client when (re)opening a session. Combines the
  // session doc and the newest `limit` messages so the UI reconstructs state from a single
  // round-trip and never needs to fall back to localStorage.
  router.get('/chat/sessions/:sessionId/bootstrap', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const pageSize = Math.min(
        Math.max(Number.parseInt(req.query.limit, 10) || CURSOR_DATA_SIZE, 1),
        MAX_PAGE_SIZE,
      );

      const [sessionDoc, rows] = await Promise.all([
        mateyChatSessionsStorage.findOne({ sessionId }),
        messagesJobStorage
          .find({ sessionId })
          .sort({ createdAt: -1, _id: -1 })
          .limit(pageSize + 1)
          .toArray(),
      ]);

      const hasMore = rows.length > pageSize;
      const sliced = hasMore ? rows.slice(0, pageSize) : rows;
      const nextCursor = hasMore ? encodeCursor(sliced[sliced.length - 1]) : null;

      return res.json({
        success: true,
        sessionId,
        session: sessionDoc || null,
        messages: sliced.reverse().map(toPublicMessage),
        pagination: {
          hasMore,
          nextCursor,
          limit: pageSize,
        },
      });
    } catch (error) {
      console.error('Error bootstrapping chat session:', error);
      return res.status(500).json({ error: 'Failed to bootstrap session' });
    }
  });
  router.delete('/chat/sessions/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const now = new Date();
      const runDelete = async (session) => {
        const deleteResult = await messagesJobStorage.deleteMany({ sessionId }, session ? { session } : undefined);
        await mateyChatSessionsStorage.updateOne(
          { sessionId },
          {
            $set: {
              messageCount: 0,
              userMessageCount: 0,
              mateyMessageCount: 0,
              title: DEFAULT_TITLE,
              updatedAt: now,
              lastMessageAt: now,
            },
          },
          session ? { session } : undefined,
        );
        return deleteResult.deletedCount || 0;
      };

      let deletedCount = 0;
      if (mongoClient && typeof mongoClient.startSession === 'function' && process.env.MONGO_TRANSACTIONS !== 'false') {
        const session = mongoClient.startSession();
        try {
          await session.withTransaction(async () => {
            deletedCount = await runDelete(session);
          });
        } finally {
          await session.endSession();
        }
      } else {
        deletedCount = await runDelete(null);
      }

      try {
        await auditLogger.logAudit({
          action: 'DELETE',
          resource: 'messages_job_session',
          resourceId: sessionId,
          userId: 'system',
          userEmail: 'system@toolmate.com',
          role: 'user',
          newData: { sessionId, deletedCount },
          ...getUserInfoFromRequest(req),
        });
      } catch (auditError) {
        console.error('Audit log failed (non-fatal):', auditError);
      }

      if (typeof notifyActiveSessionsChanged === 'function') {
        notifyActiveSessionsChanged();
      }

      return res.json({ success: true, sessionId, deletedCount });
    } catch (error) {
      console.error('Error deleting chat session:', error);
      return res.status(500).json({ error: 'Failed to delete session' });
    }
  });

  router.get('/admin/chat-sessions', async (req, res) => {
    try {
      const { page = 1, limit = 20, search, lightweight = 'false' } = req.query;
      const pageNumber = Math.max(Number.parseInt(page, 10) || 1, 1);
      const limitNumber = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const skip = (pageNumber - 1) * limitNumber;

      const query = { messageCount: { $gt: 0 } };
      if (search && typeof search === 'string' && search.trim()) {
        query.$or = [
          { userName: { $regex: search.trim(), $options: 'i' } },
          { userEmail: { $regex: search.trim(), $options: 'i' } },
          { title: { $regex: search.trim(), $options: 'i' } },
        ];
      }

      const projection =
        lightweight === 'true'
          ? {
              sessionId: 1,
              userId: 1,
              userEmail: 1,
              userName: 1,
              title: 1,
              messageCount: 1,
              userMessageCount: 1,
              mateyMessageCount: 1,
              createdAt: 1,
              updatedAt: 1,
              lastMessageAt: 1,
            }
          : {};

      const [sessions, total] = await Promise.all([
        mateyChatSessionsStorage
          .find(query, { projection })
          .sort({ lastMessageAt: -1, updatedAt: -1, createdAt: -1 })
          .skip(skip)
          .limit(limitNumber)
          .toArray(),
        mateyChatSessionsStorage.countDocuments(query),
      ]);

      const enriched = await Promise.all(
        sessions.map(async (sessionDoc) => {
          const emailToQuery = normalizeEmailValue(sessionDoc.userEmail);
          const [user, latestUserMessage] = await Promise.all([
            emailToQuery ? usersStorage.findOne({ userEmail: emailToQuery }) : null,
            messagesJobStorage.findOne(
              {
                sessionId: sessionDoc.sessionId,
                role: 'user',
                content: { $type: 'string' },
              },
              {
                sort: { createdAt: -1, _id: -1 },
                projection: { content: 1 },
              },
            ),
          ]);

          return {
            ...sessionDoc,
            prompt: latestUserMessage?.content || '',
            timestamp: sessionDoc.lastMessageAt || sessionDoc.updatedAt || sessionDoc.createdAt,
            flagTriggered: false,
            toolCount: 0,
            userDetails: user || null,
          };
        }),
      );

      return res.json({
        sessions: enriched,
        pagination: {
          current: pageNumber,
          total: Math.ceil(total / limitNumber),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching admin chat sessions from messages-job:', error);
      return res.status(500).json({ error: 'Failed to fetch chat sessions' });
    }
  });

  router.get('/admin/chat-sessions/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const sessionDoc = await mateyChatSessionsStorage.findOne({ sessionId });
      if (!sessionDoc) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const emailToQuery = normalizeEmailValue(sessionDoc.userEmail);
      const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null;

      return res.json({
        ...sessionDoc,
        userDetails: user || null,
      });
    } catch (error) {
      console.error('Error fetching admin chat session from messages-job:', error);
      return res.status(500).json({ error: 'Failed to fetch session' });
    }
  });

  router.get('/admin/chat-sessions/:sessionId/details', async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const [firstUserRow, lastMateyRow, mateyToolRows] = await Promise.all([
        messagesJobStorage.findOne(
          { sessionId, role: 'user' },
          {
            sort: { createdAt: 1, _id: 1 },
            projection: { content: 1 },
          },
        ),
        messagesJobStorage.findOne(
          { sessionId, role: 'matey' },
          {
            sort: { createdAt: -1, _id: -1 },
            projection: { content: 1 },
          },
        ),
        messagesJobStorage
          .find(
            { sessionId, role: 'matey', suggestedTools: { $exists: true, $ne: [] } },
            { projection: { suggestedTools: 1 } },
          )
          .sort({ createdAt: -1, _id: -1 })
          .limit(100)
          .toArray(),
      ]);

      const suggestedTools = mateyToolRows.flatMap((row) => normalizeArray(row.suggestedTools));

      return res.json({
        suggestedTools,
        mateyResponse: lastMateyRow?.content || '',
        fullPrompt: firstUserRow?.content || '',
      });
    } catch (error) {
      console.error('Error fetching admin chat session details from messages-job:', error);
      return res.status(500).json({ error: 'Failed to fetch session details' });
    }
  });

  router.get('/admin/messages-job-logs', async (req, res) => {
    try {
      const { page = 1, limit = 20, search, userId, dateFrom, dateTo, lightweight } = req.query;
      const pageNumber = Math.max(Number.parseInt(page, 10) || 1, 1);
      const limitNumber = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const skip = (pageNumber - 1) * limitNumber;

      const query = {
        role: 'matey',
        $or: [{ content: { $type: 'string', $ne: '' } }, { images: { $exists: true, $ne: [] } }],
      };

      if (dateFrom || dateTo) {
        query.createdAt = {};
        if (dateFrom) query.createdAt.$gte = new Date(dateFrom);
        if (dateTo) query.createdAt.$lte = new Date(dateTo);
      }

      if (userId) {
        query.$or = [{ userEmail: userId }, { userId }];
      }

      if (search && typeof search === 'string' && search.trim()) {
        const searchRegex = { $regex: search.trim(), $options: 'i' };
        query.$and = [
          {
            $or: [{ content: searchRegex }, { userEmail: searchRegex }, { userId: searchRegex }],
          },
        ];
      }

      const projection =
        lightweight === 'true'
          ? {
              sessionId: 1,
              userId: 1,
              userEmail: 1,
              metadata: 1,
              createdAt: 1,
              updatedAt: 1,
            }
          : {
              sessionId: 1,
              userId: 1,
              userEmail: 1,
              content: 1,
              suggestedTools: 1,
              toolsUsed: 1,
              metadata: 1,
              createdAt: 1,
              updatedAt: 1,
            };

      const [rows, total] = await Promise.all([
        messagesJobStorage
          .find(query, { projection })
          .sort({ createdAt: -1, _id: -1 })
          .skip(skip)
          .limit(limitNumber)
          .toArray(),
        messagesJobStorage.countDocuments(query),
      ]);

      const jobLogs = await Promise.all(
        rows.map(async (row) => {
          const [sessionDoc, latestPromptDoc] = await Promise.all([
            mateyChatSessionsStorage.findOne(
              { sessionId: row.sessionId },
              { projection: { userName: 1, userEmail: 1, sessionId: 1 } },
            ),
            messagesJobStorage.findOne(
              {
                sessionId: row.sessionId,
                role: 'user',
                createdAt: { $lte: row.createdAt },
              },
              {
                sort: { createdAt: -1, _id: -1 },
                projection: { content: 1 },
              },
            ),
          ]);

          const userEmail = row.userEmail || sessionDoc?.userEmail || null;
          const emailToQuery = normalizeEmailValue(userEmail);
          const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null;

          return {
            _id: row._id,
            sessionId: row.sessionId,
            userName: sessionDoc?.userName || 'Anonymous',
            userEmail,
            prompt: latestPromptDoc?.content || '',
            mateyResponse: typeof row.content === 'string' ? row.content : '',
            timestamp: row.createdAt,
            metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
            userDetails: user || null,
          };
        }),
      );

      return res.json({
        jobLogs,
        pagination: {
          current: pageNumber,
          total: Math.ceil(total / limitNumber),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching admin messages-job logs:', error);
      return res.status(500).json({ error: 'Failed to fetch admin job logs' });
    }
  });

  router.get('/admin/messages-job-logs/:id/details', async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid job log ID format' });
      }

      const row = await messagesJobStorage.findOne({ _id: new ObjectId(id), role: 'matey' });
      if (!row) {
        return res.status(404).json({ error: 'Job log not found' });
      }

      const [sessionDoc, latestPromptDoc] = await Promise.all([
        mateyChatSessionsStorage.findOne({ sessionId: row.sessionId }),
        messagesJobStorage.findOne(
          {
            sessionId: row.sessionId,
            role: 'user',
            createdAt: { $lte: row.createdAt },
          },
          {
            sort: { createdAt: -1, _id: -1 },
            projection: { content: 1 },
          },
        ),
      ]);

      const userEmail = row.userEmail || sessionDoc?.userEmail || null;
      const emailToQuery = normalizeEmailValue(userEmail);
      const user = emailToQuery ? await usersStorage.findOne({ userEmail: emailToQuery }) : null;

      return res.json({
        _id: row._id,
        sessionId: row.sessionId,
        userName: sessionDoc?.userName || 'Anonymous',
        userEmail,
        prompt: latestPromptDoc?.content || '',
        mateyResponse: typeof row.content === 'string' ? row.content : '',
        timestamp: row.createdAt,
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        userDetails: user || null,
      });
    } catch (error) {
      console.error('Error fetching admin messages-job log details:', error);
      return res.status(500).json({ error: 'Failed to fetch job log details' });
    }
  });

  router.put('/admin/messages-job-logs/:id/notes', async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body || {};

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid job log ID format' });
      }

      const existing = await messagesJobStorage.findOne({ _id: new ObjectId(id), role: 'matey' });
      if (!existing) {
        return res.status(404).json({ error: 'Job log not found' });
      }

      const metadata = existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};
      metadata.notes = typeof notes === 'string' ? notes : '';

      await messagesJobStorage.updateOne(
        { _id: existing._id },
        {
          $set: {
            metadata,
            updatedAt: new Date(),
          },
        },
      );

      return res.json({ success: true, message: 'Job log notes updated successfully' });
    } catch (error) {
      console.error('Error updating admin messages-job log notes:', error);
      return res.status(500).json({ error: 'Failed to update job log notes' });
    }
  });

  router.delete('/admin/messages-job-logs/:id', async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid job log ID format' });
      }

      const result = await messagesJobStorage.deleteOne({ _id: new ObjectId(id), role: 'matey' });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Job log not found' });
      }

      return res.json({ success: true, message: 'Job log deleted successfully' });
    } catch (error) {
      console.error('Error deleting admin messages-job log:', error);
      return res.status(500).json({ error: 'Failed to delete job log' });
    }
  });

  return router;
};
