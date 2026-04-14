const express = require('express');
const { ObjectId } = require('mongodb');

class LRUCache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.cache = new Map();
  }

  get(key) {
    if (this.cache.has(key)) {
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    return null;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }
}

module.exports = ({
  sessionsStorage,
  chatLogsStorage,
  usersStorage,
  auditLogger,
  emitNewLiveMessage,
  notifyActiveSessionsChanged,
  getUserInfoFromRequest,
}) => {
  const router = express.Router();

  const chatCache = new LRUCache(100);

  const normalizeEmailValue = (email) => {
    if (Array.isArray(email)) {
      return email[0] || null;
    }
    return email || null;
  };

  const getEffectiveMessageTimestamp = (message) => {
    const raw = message?.timestamp || message?.createdAt;
    const parsed = raw ? new Date(raw) : new Date(0);
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  };

  const toSignature = (message = {}) => {
    const timestamp = getEffectiveMessageTimestamp(message).toISOString();
    return [
      message?.id || '',
      message?.sender || '',
      message?.text || '',
      timestamp,
      message?.streamId || '',
      message?.responseGroupId || '',
      Number.isFinite(message?.partIndex) ? message.partIndex : '',
    ].join('|');
  };

  const normalizeMessage = (message = {}, sessionId = '') => {
    return {
      ...message,
      id: message?.id || `${sessionId || 'session'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender: message?.sender || 'matey',
      text: typeof message?.text === 'string' ? message.text : '',
      timestamp: message?.timestamp || message?.createdAt || new Date(),
    };
  };

  const sortMessagesAscending = (messages = []) => {
    return messages.slice().sort((a, b) => {
      return getEffectiveMessageTimestamp(a) - getEffectiveMessageTimestamp(b);
    });
  };

  const mergeMessages = (existingMessages = [], incomingMessages = [], sessionId = '') => {
    const merged = [];
    const seenIds = new Set();
    const seenSignatures = new Set();

    [...existingMessages, ...incomingMessages].forEach((rawMessage) => {
      const message = normalizeMessage(rawMessage, sessionId);
      const signature = toSignature(message);

      if (message.id && seenIds.has(message.id)) {
        return;
      }

      if (seenSignatures.has(signature)) {
        return;
      }

      if (message.id) {
        seenIds.add(message.id);
      }
      seenSignatures.add(signature);
      merged.push(message);
    });

    return sortMessagesAscending(merged);
  };

  const getLatestConversationPair = (messages = [], fallbackPrompt = '', fallbackResponse = '') => {
    const sortedMessages = sortMessagesAscending(messages);
    if (sortedMessages.length === 0) {
      return {
        latestPrompt: fallbackPrompt || '',
        latestMateyResponse: fallbackResponse || '',
        latestMateyParts: [],
      };
    }

    let latestUserIndex = -1;
    for (let i = sortedMessages.length - 1; i >= 0; i -= 1) {
      if (sortedMessages[i]?.sender === 'user') {
        latestUserIndex = i;
        break;
      }
    }

    const latestPrompt =
      latestUserIndex >= 0 ? sortedMessages[latestUserIndex]?.text || fallbackPrompt || '' : fallbackPrompt || '';

    const responseWindow =
      latestUserIndex >= 0
        ? sortedMessages.slice(latestUserIndex + 1).filter((message) => message?.sender === 'matey')
        : sortedMessages.filter((message) => message?.sender === 'matey');

    if (responseWindow.length === 0) {
      return {
        latestPrompt,
        latestMateyResponse: fallbackResponse || '',
        latestMateyParts: [],
      };
    }

    const latestMateyMessage = responseWindow[responseWindow.length - 1];
    const latestGroupId = latestMateyMessage?.responseGroupId;
    const groupedParts = latestGroupId
      ? responseWindow.filter((message) => message?.responseGroupId === latestGroupId)
      : responseWindow;

    const orderedParts = groupedParts.slice().sort((a, b) => {
      const partA = Number.isFinite(a?.partIndex) ? a.partIndex : Number.MAX_SAFE_INTEGER;
      const partB = Number.isFinite(b?.partIndex) ? b.partIndex : Number.MAX_SAFE_INTEGER;
      if (partA !== partB) {
        return partA - partB;
      }
      return getEffectiveMessageTimestamp(a) - getEffectiveMessageTimestamp(b);
    });

    const latestMateyResponse = orderedParts.map((part) => part?.text || '').join('\n\n').trim() || fallbackResponse || '';

    return {
      latestPrompt,
      latestMateyResponse,
      latestMateyParts: orderedParts,
    };
  };

  router.post('/store-session', async (req, res) => {
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

      const userInfo = getUserInfoFromRequest(req);
      const timestamp = new Date();
      const normalizedUserEmail = normalizeEmailValue(userEmail);

      const incomingMessages = Array.isArray(messages)
        ? messages.map((message) => normalizeMessage(message, sessionId))
        : [];

      const existingSession = await sessionsStorage.findOne({
        sessionId,
        $or: [{ userEmail: normalizedUserEmail }, { userEmail: { $in: [normalizedUserEmail] } }],
      });

      const mergedMessages = mergeMessages(existingSession?.messages || [], incomingMessages, sessionId);
      const latestPair = getLatestConversationPair(mergedMessages, prompt, mateyResponse);

      const sessionData = {
        sessionId,
        userName,
        userEmail,
        prompt: latestPair.latestPrompt,
        mateyResponse: latestPair.latestMateyResponse,
        latestPrompt: latestPair.latestPrompt,
        latestMateyResponse: latestPair.latestMateyResponse,
        suggestedTools,
        budgetTier,
        timestamp,
        flagTriggered,
        messages: mergedMessages,
      };

      const logData = {
        sessionId,
        userEmail,
        userName,
        prompt: latestPair.latestPrompt,
        mateyResponse: latestPair.latestMateyResponse,
        mateyResponseParts: latestPair.latestMateyParts,
        suggestedTools,
        budgetTier,
        timestamp,
        flagTriggered,
        metadata: {
          userAgent: req.headers['user-agent'],
          ip: req.ip,
        },
      };

      if (latestPair.latestMateyParts.length > 0 && sessionId) {
        const latestResponseParts = latestPair.latestMateyParts;
        const normalizedParts =
          latestResponseParts.length > 0
            ? latestResponseParts
            : [{ id: `fallback-${Date.now()}`, text: latestPair.latestMateyResponse || '' }];
        const totalParts = normalizedParts.length;
        const responseGroupId =
          normalizedParts[normalizedParts.length - 1]?.responseGroupId || `${sessionId}-${Date.now()}`;

        normalizedParts.forEach((part, index) => {
          emitNewLiveMessage({
            messageId: part.id || `${responseGroupId}-${index}`,
            responseGroupId,
            partIndex: index,
            totalParts,
            sessionId,
            userName,
            userEmail,
            timestamp: part.timestamp || timestamp,
            messageText: part.text,
            userPrompt: latestPair.latestPrompt,
          });
        });
      }
      const [sessionUpsert, latestExistingLog] = await Promise.all([
        sessionsStorage.updateOne(
          {
            sessionId,
            $or: [{ userEmail: normalizedUserEmail }, { userEmail: { $in: [normalizedUserEmail] } }],
          },
          { $set: sessionData },
          { upsert: true }
        ),
        chatLogsStorage.findOne(
          {
            sessionId,
            $or: [{ userEmail: normalizedUserEmail }, { userEmail: { $in: [normalizedUserEmail] } }],
          },
          { sort: { timestamp: -1 } }
        ),
      ]);

      let logInsert = { insertedId: null };
      const isDuplicateLog =
        latestExistingLog &&
        latestExistingLog.prompt === logData.prompt &&
        latestExistingLog.mateyResponse === logData.mateyResponse;

      if (!isDuplicateLog && (logData.prompt || logData.mateyResponse)) {
        logInsert = await chatLogsStorage.insertOne(logData);
      }

      const sessionAuditId = sessionUpsert.upsertedId || `${sessionId}:${normalizedUserEmail || 'unknown'}`;
      await auditLogger.logAudit({
        action: 'CREATE',
        resource: 'session',
        resourceId: sessionAuditId.toString(),
        userId: userEmail,
        userEmail: userEmail,
        role: 'user',
        newData: {
          sessionId,
          userName,
          prompt,
          budgetTier,
          flagTriggered,
        },
        ...userInfo,
      });

      notifyActiveSessionsChanged();
      res.json({
        success: true,
        sessionId: sessionAuditId,
        logId: logInsert.insertedId,
      });
    } catch (error) {
      console.error('Error storing session:', error);
      res.status(500).json({ error: 'Failed to store session' });
    }
  });

  router.get('/admin/chat-logs', async (req, res) => {
    try {
      const { page = 1, limit = 50, search, flaggedOnly } = req.query;
      const skip = (page - 1) * limit;
      const matchStage = {};
      if (search) {
        matchStage.$or = [
          { userName: { $regex: search, $options: 'i' } },
          { prompt: { $regex: search, $options: 'i' } },
          { mateyResponse: { $regex: search, $options: 'i' } },
        ];
      }
      if (flaggedOnly === 'true') {
        matchStage.flagTriggered = true;
      }
      const pipeline = [
        { $match: matchStage },
        { $sort: { timestamp: -1 } },
        { $skip: skip },
        { $limit: Number.parseInt(limit) },
        {
          $addFields: {
            promptPreview: { $substr: ['$prompt', 0, 150] },
          },
        },
        {
          $project: {
            sessionId: 1,
            userName: 1,
            userEmail: 1,
            promptPreview: 1,
            timestamp: 1,
            flagTriggered: 1,
            budgetTier: 1,
          },
        },
        {
          $lookup: {
            from: 'users',
            let: {
              userEmails: {
                $cond: {
                  if: { $isArray: '$userEmail' },
                  then: '$userEmail',
                  else: ['$userEmail'],
                },
              },
            },
            pipeline: [
              { $match: { $expr: { $in: ['$userEmail', '$$userEmails'] } } },
              { $limit: 1 },
              { $project: { userEmail: 1, userName: 1, createdAt: 1, _id: 1 } },
            ],
            as: 'userDetails',
          },
        },
        {
          $addFields: {
            userDetails: { $arrayElemAt: ['$userDetails', 0] },
          },
        },
      ];
      const [logs, totalResult] = await Promise.all([
        chatLogsStorage.aggregate(pipeline).toArray(),
        chatLogsStorage.aggregate([{ $match: matchStage }, { $count: 'total' }]).toArray(),
      ]);
      const total = totalResult[0]?.total || 0;
      res.json({
        logs,
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
  router.get('/admin/chat-logs/:id/details', async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid chat log ID format' });
      }
      const chatLog = await chatLogsStorage.findOne({ _id: new ObjectId(id) });
      if (!chatLog) {
        return res.status(404).json({ error: 'Chat log not found' });
      }
      res.json({
        _id: chatLog._id,
        sessionId: chatLog.sessionId,
        userName: chatLog.userName,
        userEmail: chatLog.userEmail,
        prompt: chatLog.prompt,
        mateyResponse: chatLog.mateyResponse,
        mateyResponseParts: chatLog.mateyResponseParts || [],
        suggestedTools: chatLog.suggestedTools || [],
        timestamp: chatLog.timestamp,
        flagTriggered: chatLog.flagTriggered,
        budgetTier: chatLog.budgetTier,
      });
    } catch (error) {
      console.error('Error fetching chat log details:', error);
      res.status(500).json({ error: 'Failed to fetch chat log details' });
    }
  });

  router.get('/admin/sessions', async (req, res) => {
    try {
      const { page = 1, limit = 20, search, lightweight = 'false' } = req.query;
      const pageNumber = Math.max(Number.parseInt(page, 10) || 1, 1);
      const limitNumber = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const skip = (pageNumber - 1) * limitNumber;
      const matchStage = {};
      if (search) {
        matchStage.$or = [
          { userName: { $regex: search, $options: 'i' } },
          { prompt: { $regex: search, $options: 'i' } },
        ];
      }

      const pipeline = [
        { $match: matchStage },
        { $sort: { timestamp: -1 } },
        {
          $addFields: {
            normalizedEmail: {
              $cond: {
                if: { $isArray: '$userEmail' },
                then: { $arrayElemAt: ['$userEmail', 0] },
                else: '$userEmail',
              },
            },
          },
        },
        {
          $group: {
            _id: {
              email: '$normalizedEmail',
              sessionId: '$sessionId',
            },
            latestSession: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$latestSession' } },
        { $skip: skip },
        { $limit: limitNumber },
      ];
      if (lightweight === 'true') {
        pipeline.push({
          $project: {
            sessionId: 1,
            userName: 1,
            userEmail: 1,
            prompt: { $substr: ['$prompt', 0, 150] },
            timestamp: 1,
            flagTriggered: 1,
            budgetTier: 1,
            messageCount: { $size: { $ifNull: ['$messages', []] } },
            toolCount: { $size: { $ifNull: ['$suggestedTools', []] } },
          },
        });
      }
      pipeline.push({
        $lookup: {
          from: 'users',
          let: {
            emailToQuery: {
              $cond: {
                if: { $isArray: '$userEmail' },
                then: { $arrayElemAt: ['$userEmail', 0] },
                else: '$userEmail',
              },
            },
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $ne: ['$$emailToQuery', null] }, { $eq: ['$userEmail', '$$emailToQuery'] }],
                },
              },
            },
            { $limit: 1 },
            { $project: { userEmail: 1, userName: 1, createdAt: 1, _id: 1, isSubscribed: 1, userImage: 1, role: 1 } },
          ],
          as: 'userDetails',
        },
      });

      pipeline.push({
        $addFields: {
          userDetails: { $arrayElemAt: ['$userDetails', 0] },
        },
      });

      const [sessions, totalResult] = await Promise.all([
        sessionsStorage.aggregate(pipeline, { allowDiskUse: true }).toArray(),
        sessionsStorage
          .aggregate([
            { $match: matchStage },
            {
              $addFields: {
                normalizedEmail: {
                  $cond: {
                    if: { $isArray: '$userEmail' },
                    then: { $arrayElemAt: ['$userEmail', 0] },
                    else: '$userEmail',
                  },
                },
              },
            },
            {
              $group: {
                _id: {
                  email: '$normalizedEmail',
                  sessionId: '$sessionId',
                },
              },
            },
            { $count: 'total' },
          ], { allowDiskUse: true })
          .toArray(),
      ]);
      const total = totalResult[0]?.total || 0;
      res.json({
        sessions,
        pagination: {
          current: pageNumber,
          total: Math.ceil(total / limitNumber),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching sessions:', error);
      res.status(500).json({ error: 'Failed to fetch sessions' });
    }
  });

  router.get('/admin/sessions/:id/details', async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid session ID format' });
      }
      const session = await sessionsStorage.findOne(
        { _id: new ObjectId(id) },
        {
          projection: {
            messages: 1,
            suggestedTools: 1,
            mateyResponse: 1,
            prompt: 1,
          },
        }
      );

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const sortedMessages = (session.messages || []).slice().sort((a, b) => {
        return getEffectiveMessageTimestamp(a) - getEffectiveMessageTimestamp(b);
      });

      res.json({
        messages: sortedMessages,
        suggestedTools: session.suggestedTools || [],
        mateyResponse: session.mateyResponse || '',
        fullPrompt: session.prompt || '',
      });
    } catch (error) {
      console.error('Error fetching session details:', error);
      res.status(500).json({ error: 'Failed to fetch session details' });
    }
  });

  router.get('/admin/sessions/:id', async (req, res) => {
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

  router.get('/admin/active-sessions', async (req, res) => {
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
                sessionId: '$sessionId',
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

  router.get('/chats/:sessionId/:userEmail', async (req, res) => {
    try {
      const { sessionId, userEmail } = req.params;
      const { page = 1, limit = 50 } = req.query;
      if (!sessionId || !userEmail) {
        return res.status(400).json({ error: 'SessionId and userEmail are required' });
      }
      const cacheKey = `${sessionId}:${userEmail}`;
      const cachedData = chatCache.get(cacheKey);
      if (cachedData) {
        res.json({
          success: true,
          sessionId: cachedData.sessionId,
          userEmail: cachedData.userEmail,
          userName: cachedData.userName,
          messages: cachedData.messages,
          timestamp: cachedData.timestamp,
          budgetTier: cachedData.budgetTier,
          flagTriggered: cachedData.flagTriggered,
          fromCache: true,
          totalCached: cachedData.messages.length,
        });
        return;
      }
      const session = await sessionsStorage.findOne({
        sessionId: sessionId,
        $or: [{ userEmail: userEmail }, { userEmail: { $in: [userEmail] } }],
      });
      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const allMessages = (session.messages || []).sort(
        (a, b) => new Date(a.timestamp || a.createdAt) - new Date(b.timestamp || b.createdAt)
      );
      const last50Messages = allMessages.slice(-50);
      const cacheData = {
        sessionId: session.sessionId,
        userEmail: session.userEmail,
        userName: session.userName,
        messages: last50Messages,
        timestamp: session.timestamp,
        budgetTier: session.budgetTier,
        flagTriggered: session.flagTriggered,
      };
      chatCache.set(cacheKey, cacheData);
      const skip = (page - 1) * limit;
      const paginatedMessages = allMessages.slice(skip, skip + Number.parseInt(limit));
      res.json({
        success: true,
        sessionId: session.sessionId,
        userEmail: session.userEmail,
        userName: session.userName,
        messages: paginatedMessages,
        timestamp: session.timestamp,
        budgetTier: session.budgetTier,
        flagTriggered: session.flagTriggered,
        fromCache: false,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(allMessages.length / limit),
          count: allMessages.length,
          showing: paginatedMessages.length,
        },
      });
    } catch (error) {
      console.error('Error fetching chats:', error);
      res.status(500).json({ error: 'Failed to fetch chats' });
    }
  });
  return router;
};
