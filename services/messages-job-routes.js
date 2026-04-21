const express = require('express');
const { ObjectId } = require('mongodb');
const { createChatRateLimiter } = require('./chat-rate-limit');
const { createRequireAuth, normalizeEmail } = require('./auth-middleware');
const { enrichUserWithSubscription } = require('./subscription-status');
const CURSOR_DATA_SIZE = 30;
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
const normalizeStringArray = (value) =>
  normalizeArray(value)
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
const normalizeToolText = (value) =>
  (typeof value === 'string' ? value : '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const containsWholePhrase = (haystack, phrase) => {
  if (!haystack || !phrase) return false;
  const regex = new RegExp(`(^|\\s)${escapeRegex(phrase)}(\\s|$)`, 'i');
  return regex.test(haystack);
};
const TOOL_TOKEN_STOPWORDS = new Set([
  'set',
  'kit',
  'tool',
  'tools',
  'pack',
  'piece',
  'pieces',
  'pc',
  'pcs',
  'with',
  'and',
  'for',
]);
const toMeaningfulTokens = (value) =>
  normalizeToolText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !TOOL_TOKEN_STOPWORDS.has(token));
const STAGE_ORDER = ['planning', 'buying', 'building', 'finishing', 'done'];
const STAGE_WEIGHT = STAGE_ORDER.reduce((acc, stage, index) => {
  acc[stage] = index;
  return acc;
}, {});
const DECISION_FIELD_LABELS = {
  budgetTier: 'Budget tier',
  materialChosen: 'Material chosen',
  finishChosen: 'Finish chosen',
  ownedToolsConfirmed: 'Owned tools confirmed',
  measurementsConfirmed: 'Measurements confirmed',
};

const toToolName = (tool) => {
  if (typeof tool === 'string') return tool.trim();
  if (!tool || typeof tool !== 'object') return '';
  const candidates = [
    tool.name,
    tool.display_name,
    tool.product_name,
    tool.tool_name,
    tool.toolName,
    tool.productName,
    tool.title,
    tool.label,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
};

const extractToolNames = (tools) => {
  const unique = new Map();
  normalizeArray(tools).forEach((tool) => {
    const name = toToolName(tool);
    if (!name) return;
    const key = name.toLowerCase();
    if (!unique.has(key)) {
      unique.set(key, name);
    }
  });
  return Array.from(unique.values());
};

const buildSuggestedToolMetaMap = (tools) => {
  const toolMap = new Map();
  normalizeArray(tools).forEach((tool) => {
    if (!tool || typeof tool !== 'object') return;
    const name = toToolName(tool);
    if (!name) return;
    const key = name.toLowerCase();
    if (!toolMap.has(key)) {
      toolMap.set(key, tool);
    }
  });
  return toolMap;
};

const isOptionalBySuggestionMeta = (tool) => {
  if (!tool || typeof tool !== 'object') return false;
  const isTruthy = (value) => value === true || value === 1 || value === '1' || value === 'true';
  if (isTruthy(tool.isOptional) || isTruthy(tool.optional)) return true;
  if (typeof tool.priority === 'string' && tool.priority.toLowerCase() === 'optional') return true;
  // In ToolMate payloads, boosted items are prioritized enhancements.
  if (isTruthy(tool.boosted)) return true;
  return false;
};

const classifyToolName = (name) => {
  const lowered = name.toLowerCase();
  if (
    /screw|nail|plug|adhesive|sealant|paint|sandpaper|blade|bit|caulk|glue|tape|primer|oil|battery/.test(
      lowered,
    )
  ) {
    return 'consumables';
  }
  if (/upgrade|premium|pro|advanced|optional/.test(lowered)) {
    return 'optionalUpgrades';
  }
  return 'mustBuy';
};

const inferStageFromContent = (content, fallback = 'planning') => {
  const lowered = (typeof content === 'string' ? content : '').toLowerCase();
  if (/done|completed|finished all|project complete/.test(lowered)) return 'done';
  if (/finish|paint|sand|seal|coat|final touch/.test(lowered)) return 'finishing';
  if (/build|install|assemble|mount|cut|drill/.test(lowered)) return 'building';
  if (/buy|purchase|shop|order|missing|need to get/.test(lowered)) return 'buying';
  if (/plan|decide|measure|scope|design/.test(lowered)) return 'planning';
  return STAGE_ORDER.includes(fallback) ? fallback : 'planning';
};

const extractDecisionLogEntries = (metadata, createdAt) => {
  const entries = [];
  if (!metadata || typeof metadata !== 'object') return entries;
  Object.keys(DECISION_FIELD_LABELS).forEach((key) => {
    if (metadata[key] === undefined || metadata[key] === null || metadata[key] === '') return;
    entries.push({
      key,
      label: DECISION_FIELD_LABELS[key],
      value: metadata[key],
      decidedAt: createdAt,
    });
  });
  return entries;
};

const mergeDecisionLog = (previous = [], incoming = []) => {
  const merged = new Map();
  normalizeArray(previous).forEach((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.key) return;
    merged.set(entry.key, entry);
  });
  normalizeArray(incoming).forEach((entry) => {
    if (!entry || typeof entry !== 'object' || !entry.key) return;
    merged.set(entry.key, entry);
  });
  return Array.from(merged.values()).sort(
    (a, b) => new Date(a.decidedAt || 0).getTime() - new Date(b.decidedAt || 0).getTime(),
  );
};

const estimateSpendByBudgetTier = (tools, budgetHint) => {
  const base = Math.max(normalizeArray(tools).length, 1);
  const budgetBase = Number.isFinite(Number(budgetHint)) ? Number(budgetHint) : base * 60;
  return {
    low: Math.round(budgetBase * 0.8),
    mid: Math.round(budgetBase),
    high: Math.round(budgetBase * 1.35),
  };
};

const buildDerivedJobState = ({
  messageDoc,
  previousJobState = {},
  shedToolNames = [],
}) => {
  const previous = previousJobState && typeof previousJobState === 'object' ? previousJobState : {};
  const previousStage = previous.stageTracker && typeof previous.stageTracker === 'object' ? previous.stageTracker : {};
  const metadata = messageDoc.metadata && typeof messageDoc.metadata === 'object' ? messageDoc.metadata : {};
  const suggestedToolNames = extractToolNames(messageDoc.suggestedTools);
  const suggestedToolMetaMap = buildSuggestedToolMetaMap(messageDoc.suggestedTools);
  const normalizedOwnedToolNames = normalizeStringArray(shedToolNames).map((name) => normalizeToolText(name));
  const ownedTokenSets = normalizedOwnedToolNames.map((name) => new Set(toMeaningfulTokens(name)));
  const isCoveredByShed = (suggestedName) => {
    const normalizedSuggested = normalizeToolText(suggestedName);
    if (!normalizedSuggested) return false;
    const suggestedTokens = toMeaningfulTokens(normalizedSuggested);
    return normalizedOwnedToolNames.some((ownedName, idx) => {
      if (ownedName === normalizedSuggested) return true;
      if (containsWholePhrase(normalizedSuggested, ownedName) || containsWholePhrase(ownedName, normalizedSuggested)) {
        return true;
      }

      // Keyword overlap on meaningful tool words only.
      const ownedTokenSet = ownedTokenSets[idx];
      if (!ownedTokenSet || suggestedTokens.length === 0) return false;
      return suggestedTokens.some((token) => ownedTokenSet.has(token));
    });
  };
  const alreadyOwned = suggestedToolNames.filter((name) => isCoveredByShed(name));
  const recommendationMissing = suggestedToolNames.filter((name) => !isCoveredByShed(name));
  const optionalHelpful = suggestedToolNames.filter((name) => {
    const toolMeta = suggestedToolMetaMap.get(name.toLowerCase());
    if (isOptionalBySuggestionMeta(toolMeta)) return true;
    return false;
  });
  const nonOptionalMissing = recommendationMissing.filter((name) => !optionalHelpful.includes(name));
  const mustBuy = nonOptionalMissing.filter((name) => classifyToolName(name) === 'mustBuy');
  const consumables = nonOptionalMissing.filter((name) => classifyToolName(name) === 'consumables');

  const nextStage = metadata.currentStage || inferStageFromContent(messageDoc.content, previousStage.currentStage);
  const previousWeight = STAGE_WEIGHT[previousStage.currentStage] ?? 0;
  const nextWeight = STAGE_WEIGHT[nextStage] ?? 0;
  const currentStage = nextWeight < previousWeight ? previousStage.currentStage : nextStage;
  const decisionLog = mergeDecisionLog(previous.decisionLog, extractDecisionLogEntries(metadata, messageDoc.createdAt));

  return {
    stageTracker: {
      currentStage,
      currentBlocker:
        metadata.currentBlocker ||
        metadata.blocker ||
        previousStage.currentBlocker ||
        (mustBuy.length > 0 ? `Missing: ${mustBuy.slice(0, 3).join(', ')}` : 'None'),
      nextDecision: metadata.nextDecision || previousStage.nextDecision || 'Confirm next material/tool choice',
      lastRecommendation:
        metadata.lastRecommendation ||
        (typeof messageDoc.content === 'string' && messageDoc.content.trim().slice(0, 180)) ||
        previousStage.lastRecommendation ||
        '',
    },
    savedShoppingList: {
      mustBuy,
      alreadyOwned,
      optionalUpgrades: optionalHelpful,
      consumables,
      estimatedSpendByBudgetTier: estimateSpendByBudgetTier(
        normalizeArray(messageDoc.suggestedTools),
        metadata.budget,
      ),
    },
    missingItems: {
      alreadyCovered: alreadyOwned,
      missing: nonOptionalMissing,
      optionalHelpful,
    },
    decisionLog,
    updatedAt: messageDoc.createdAt,
  };
};

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
  shedToolsStorage,
  usersStorage,
  chatLogsStorage,
  auditLogger,
  getUserInfoFromRequest,
  emitNewLiveMessage,
  notifyActiveSessionsChanged,
}) => {
  const router = express.Router();
  const requireAuth = createRequireAuth({ usersStorage });

  const normalizeEmailValue = (email) => {
    if (Array.isArray(email)) {
      return normalizeEmail(email[0]);
    }
    return normalizeEmail(email);
  };

  const isSameOwner = (sessionDoc, authUser) => {
    if (!sessionDoc || !authUser) return false;

    if (sessionDoc.userId && authUser.userId && sessionDoc.userId === authUser.userId) {
      return true;
    }

    const sessionEmail = normalizeEmailValue(sessionDoc.userEmail);
    if (sessionEmail && authUser.userEmail && sessionEmail === authUser.userEmail) {
      return true;
    }

    return false;
  };

  const isUnownedSession = (sessionDoc) => {
    if (!sessionDoc) return true;
    const sessionEmail = normalizeEmailValue(sessionDoc.userEmail);
    return !sessionDoc.userId && !sessionEmail;
  };

  const claimLegacyUnownedSession = async (sessionId, authUser) => {
    if (!authUser?.userId) return null;
    const now = new Date();

    await mateyChatSessionsStorage.updateOne(
      {
        sessionId,
        $or: [
          { userId: { $exists: false } },
          { userId: null },
          { userId: '' },
        ],
      },
      {
        $set: {
          userId: authUser.userId,
          ...(authUser.userEmail ? { userEmail: authUser.userEmail } : {}),
          updatedAt: now,
        },
      },
    );

    return mateyChatSessionsStorage.findOne({ sessionId });
  };

  const ensureSessionAccess = async ({
    sessionId,
    authUser,
    allowMissing = true,
    claimUnowned = true,
  }) => {
    const sessionDoc = await mateyChatSessionsStorage.findOne({ sessionId });

    if (!sessionDoc) {
      if (allowMissing) {
        return { sessionDoc: null, claimed: false };
      }
      return { error: { status: 404, message: 'Session not found' } };
    }

    if (isSameOwner(sessionDoc, authUser)) {
      return { sessionDoc, claimed: false };
    }

    if (claimUnowned && isUnownedSession(sessionDoc)) {
      const claimedDoc = await claimLegacyUnownedSession(sessionId, authUser);
      if (claimedDoc && isSameOwner(claimedDoc, authUser)) {
        return { sessionDoc: claimedDoc, claimed: true };
      }
    }

    return { error: { status: 403, message: 'Forbidden: session access denied' } };
  };

  const chatLimiter = createChatRateLimiter({
    perMinute: Number.parseInt(process.env.CHAT_RATE_PER_MINUTE, 10) || 120,
    perDay: Number.parseInt(process.env.CHAT_RATE_PER_DAY, 10) || 500,
    imagePerDay: Number.parseInt(process.env.CHAT_IMAGE_PER_DAY, 10) || 25,
  });
  const supportsTransactions = () => {
    return !!(mongoClient && typeof mongoClient.startSession === 'function' && process.env.MONGO_TRANSACTIONS !== 'false');
  };
  const persistMessageAtomic = async ({ messageDoc, sessionDelta }) => {
    const { sessionId } = messageDoc;
    const now = messageDoc.createdAt;
    const incomingTitle = sessionDelta.titleCandidate;
    const totalSuggestedToolsIncrement = normalizeArray(messageDoc.suggestedTools).length;
    const sessionCountersInc = {
      messageCount: 1,
      userMessageCount: messageDoc.role === 'user' ? 1 : 0,
      mateyMessageCount: messageDoc.role === 'matey' ? 1 : 0,
    };
    const incrementSuggestedTools = async (options = undefined) => {
      if (totalSuggestedToolsIncrement <= 0) return;
      await mateyChatSessionsStorage.updateOne(
        { sessionId },
        { $inc: { totalSuggestedTools: totalSuggestedToolsIncrement } },
        options,
      );
    };
    const sessionUpdate = {
      $setOnInsert: {
        sessionId,
        title: incomingTitle || DEFAULT_TITLE,
        createdAt: now,
        totalSuggestedTools: 0,
      },
      $set: {
        updatedAt: now,
        lastMessageAt: now,
        ...(sessionDelta.userId ? { userId: sessionDelta.userId } : {}),
        ...(sessionDelta.userEmail ? { userEmail: sessionDelta.userEmail } : {}),
        ...(sessionDelta.userName ? { userName: sessionDelta.userName } : {}),
      },
      $inc: sessionCountersInc,
    };
    if (sessionDelta.jobState) {
      sessionUpdate.$set.jobState = sessionDelta.jobState;
    }
    if (incomingTitle) {
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
          await incrementSuggestedTools({ session });
        });
        return inserted;
      } finally {
        await session.endSession();
      }
    }
    const insertResult = await messagesJobStorage.insertOne(messageDoc);
    await mateyChatSessionsStorage.updateOne({ sessionId }, sessionUpdate, { upsert: true });
    await incrementSuggestedTools();
    return insertResult;
  };
  router.post('/chat/session/init', requireAuth, async (req, res) => {
    try {
      const {
        sessionId,
        userName = 'Anonymous',
      } = req.body || {};
      const authUser = req.authUser;
      const verifiedUserId = authUser?.userId || null;
      const verifiedUserEmail = authUser?.userEmail || null;

      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const access = await ensureSessionAccess({
        sessionId,
        authUser,
        allowMissing: true,
        claimUnowned: true,
      });
      if (access.error) {
        return res.status(access.error.status).json({ error: access.error.message });
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
            totalSuggestedTools: 0,
          },
          $set: {
            updatedAt: now,
            ...(verifiedUserId ? { userId: verifiedUserId } : {}),
            ...(verifiedUserEmail ? { userEmail: verifiedUserEmail } : {}),
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

  router.post('/chat/messages', requireAuth, chatLimiter, async (req, res) => {
    try {
      const authUser = req.authUser;
      const verifiedUserId = authUser?.userId || null;
      const verifiedUserEmail = authUser?.userEmail || null;
      const {
        sessionId,
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

      const access = await ensureSessionAccess({
        sessionId,
        authUser,
        allowMissing: true,
        claimUnowned: true,
      });
      if (access.error) {
        return res.status(access.error.status).json({ error: access.error.message });
      }

      const normalizedImages = normalizeArray(images);
      if (!hasMessageContent(content) && normalizedImages.length === 0) {
        return res.status(400).json({ error: 'content or images are required' });
      }

      const normalizedRole = normalizeRole(role);
      const now = new Date();
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
      const previousSessionDoc = await mateyChatSessionsStorage.findOne({ sessionId });
      const previousJobState =
        previousSessionDoc?.jobState && typeof previousSessionDoc.jobState === 'object'
          ? previousSessionDoc.jobState
          : {};
      let derivedJobState = previousJobState;
      if (isToolSuggestion) {
        const shedRows = shedToolsStorage ?
          await shedToolsStorage
            .find({
              user_id: verifiedUserId,
              collection: { $ne: 'shed_analytics' },
            })
            .project({ tool_name: 1 })
            .toArray()
        : [];
        const shedToolNames = shedRows.map((row) => row.tool_name).filter(Boolean);
        derivedJobState = buildDerivedJobState({
          messageDoc: {
            content: typeof content === 'string' ? content : '',
            suggestedTools: normalizedSuggestedTools,
            metadata: normalizedMetadata,
            createdAt: now,
          },
          previousJobState,
          shedToolNames,
        });
      }
      const mergedMetadata = {
        ...normalizedMetadata,
        ...(isToolSuggestion ? { jobState: derivedJobState } : {}),
      };

      const messageDoc = {
        sessionId,
        userId: verifiedUserId,
        userEmail: verifiedUserEmail,
        role: normalizedRole,
        content: typeof content === 'string' ? content : '',
        images: normalizedImages,
        suggestedTools: normalizedSuggestedTools,
        toolsUsed: normalizeArray(toolsUsed),
        isToolSuggestion,
        metadata: mergedMetadata,
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
            userId: verifiedUserId,
            userEmail: verifiedUserEmail,
            userName,
            titleCandidate,
            ...(isToolSuggestion ? { jobState: derivedJobState } : {}),
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
            userId: verifiedUserId,
            userEmail: verifiedUserEmail,
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
              userEmail: verifiedUserEmail,
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
          userId: verifiedUserId || verifiedUserEmail || 'anonymous',
          userEmail: verifiedUserEmail || 'anonymous@toolmate.com',
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

  router.get('/chat/messages', requireAuth, async (req, res) => {
    try {
      const { sessionId, cursor, limit = DEFAULT_PAGE_SIZE } = req.query;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const access = await ensureSessionAccess({
        sessionId,
        authUser: req.authUser,
        allowMissing: true,
        claimUnowned: true,
      });
      if (access.error) {
        return res.status(access.error.status).json({ error: access.error.message });
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

  router.get('/chat/sessions', requireAuth, async (req, res) => {
    try {
      const { sessionId, limit = 20 } = req.query;
      const authUser = req.authUser;
      const userId = authUser?.userId || null;
      const userEmail = authUser?.userEmail || null;
      const pageSize = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);

      let query = { messageCount: { $gt: 0 } };

      if (sessionId) {
        const access = await ensureSessionAccess({
          sessionId,
          authUser,
          allowMissing: true,
          claimUnowned: true,
        });
        if (access.error) {
          return res.status(access.error.status).json({ error: access.error.message });
        }
        query = { sessionId, messageCount: { $gt: 0 } };
      } else if (userId) {
        query = {
          messageCount: { $gt: 0 },
          $or: [{ userId }, ...(userEmail ? [{ userEmail: normalizeEmailValue(userEmail) }] : [])],
        };
      } else if (userEmail) {
        query = { messageCount: { $gt: 0 }, userEmail: normalizeEmailValue(userEmail) };
      } else {
        return res.status(401).json({ error: 'Unauthorized: user identity missing' });
      }

      const sessions = await mateyChatSessionsStorage
        .find(query)
        .project({
          sessionId: 1,
          title: 1,
          messageCount: 1,
          userMessageCount: 1,
          mateyMessageCount: 1,
          totalSuggestedTools: 1,
          createdAt: 1,
          updatedAt: 1,
          lastMessageAt: 1,
          userEmail: 1,
          userId: 1,
          jobState: 1,
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
  router.get('/chat/sessions/:sessionId/bootstrap', requireAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const access = await ensureSessionAccess({
        sessionId,
        authUser: req.authUser,
        allowMissing: true,
        claimUnowned: true,
      });
      if (access.error) {
        return res.status(access.error.status).json({ error: access.error.message });
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
  router.delete('/chat/sessions/:sessionId', requireAuth, async (req, res) => {
    try {
      const { sessionId } = req.params;
      if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      const access = await ensureSessionAccess({
        sessionId,
        authUser: req.authUser,
        allowMissing: true,
        claimUnowned: true,
      });
      if (access.error) {
        return res.status(access.error.status).json({ error: access.error.message });
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
              totalSuggestedTools: 0,
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
          userId: req.authUser?.userId || req.authUser?.userEmail || 'system',
          userEmail: req.authUser?.userEmail || 'system@toolmate.com',
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
      const { page = 1, limit = 20, search, lightweight = 'false', activeWindowMinutes } = req.query;
      const pageNumber = Math.max(Number.parseInt(page, 10) || 1, 1);
      const limitNumber = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const skip = (pageNumber - 1) * limitNumber;

      const query = { messageCount: { $gt: 0 } };
      const activeWindow = Number.parseInt(activeWindowMinutes, 10);
      if (Number.isFinite(activeWindow) && activeWindow > 0) {
        const threshold = new Date();
        threshold.setMinutes(threshold.getMinutes() - activeWindow);
        query.lastMessageAt = { $gte: threshold };
      }
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
              totalSuggestedTools: 1,
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
            userDetails: enrichUserWithSubscription(user),
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

  router.get('/admin/chat-sessions/:sessionId/messages', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { cursor, limit = DEFAULT_PAGE_SIZE } = req.query;

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
      console.error('Error fetching admin session messages:', error);
      return res.status(500).json({ error: 'Failed to fetch session messages' });
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
        userDetails: enrichUserWithSubscription(user),
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
              content: 1,
              images: 1,
              suggestedTools: 1,
              toolsUsed: 1,
              isToolSuggestion: 1,
              metadata: 1,
              createdAt: 1,
              updatedAt: 1,
            }
          : {
              sessionId: 1,
              userId: 1,
              userEmail: 1,
              content: 1,
              images: 1,
              suggestedTools: 1,
              toolsUsed: 1,
              isToolSuggestion: 1,
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
            images: Array.isArray(row.images) ? row.images : [],
            suggestedTools: Array.isArray(row.suggestedTools) ? row.suggestedTools : [],
            toolsUsed: Array.isArray(row.toolsUsed) ? row.toolsUsed : [],
            isToolSuggestion: computeIsToolSuggestion(row),
            timestamp: row.createdAt,
            metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
            userDetails: enrichUserWithSubscription(user),
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
        images: Array.isArray(row.images) ? row.images : [],
        suggestedTools: Array.isArray(row.suggestedTools) ? row.suggestedTools : [],
        toolsUsed: Array.isArray(row.toolsUsed) ? row.toolsUsed : [],
        isToolSuggestion: computeIsToolSuggestion(row),
        timestamp: row.createdAt,
        metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
        userDetails: enrichUserWithSubscription(user),
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
