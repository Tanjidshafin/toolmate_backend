const express = require('express');
const { ObjectId } = require('mongodb');

const normalizeArray = (value) => (Array.isArray(value) ? value : []);
const normalizeEmail = (value) =>
  (typeof value === 'string' ? value : '')
    .toLowerCase()
    .trim();

module.exports = ({
  feedbackStorage,
  flaggedMessagesStorage,
  auditLogger,
  getUserInfoFromRequest,
  chatLogsStorage,
  messagesJobStorage,
  mateyChatSessionsStorage,
}) => {
  const router = express.Router();
  router.get('/get-feedback', async (req, res) => {
    try {
      const { page = 1, limit = 20, search } = req.query;
      const pageNumber = Math.max(Number.parseInt(page, 10) || 1, 1);
      const limitNumber = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
      const skip = (pageNumber - 1) * limitNumber;

      const query = {};
      if (search && search.trim() !== '') {
        const searchRegex = { $regex: search.trim(), $options: 'i' };
        query.$or = [{ messageText: searchRegex }, { name: searchRegex }, { email: searchRegex }];
      }

      const [feedback, total] = await Promise.all([
        feedbackStorage.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNumber).toArray(),
        feedbackStorage.countDocuments(query),
      ]);

      res.json({
        feedback,
        pagination: {
          current: pageNumber,
          total: Math.ceil(total / limitNumber),
          count: total,
        },
      });
    } catch (err) {
      console.error('Error fetching feedback:', err);
      res.status(500).send({
        error: 'Failed to fetch feedback',
        details: err.message,
      });
    }
  });

  router.post('/add-feedback', async (req, res) => {
    try {
      const data = req.body;
      const userInfo = getUserInfoFromRequest(req);
      const existingFeedbackQuery = {
        messageId: data.messageId,
        email: Array.isArray(data.email) ? { $in: data.email } : data.email,
        reportStatus: data.reportStatus,
      };
      const existingFeedback = await feedbackStorage.findOne(existingFeedbackQuery);
      if (existingFeedback) {
        return res.status(200).send({ message: 'Report is already added!' });
      }
      // Insert new feedback
      const feedbackInsertResult = await feedbackStorage.insertOne({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        flagTriggered: Boolean(data.reportStatus && data.feedback?.reasons),
      });
      // Prepare audit log data
      const userEmail = Array.isArray(data.email) ? data.email[0] : data.email;
      const auditData = {
        action: 'CREATE',
        resource: 'feedback',
        resourceId: feedbackInsertResult.insertedId.toString(),
        userId: userEmail,
        userEmail: userEmail,
        role: data.isLoggedInUser ? 'user' : 'anonymous',
        newData: {
          messageId: data.messageId,
          reportStatus: data.reportStatus,
          feedback: data.feedback,
        },
        ...userInfo,
      };
      await auditLogger.logAudit(auditData);
      if (data.reportStatus && data.feedback?.reasons) {
        const reasonList = normalizeArray(data.feedback.reasons).map((reason) => String(reason).trim()).filter(Boolean);
        const flaggedMessage = {
          messageId: data.messageId,
          messageText: data.messageText,
          messageTimestamp: new Date(data.messageTimestamp),
          reasons: reasonList,
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
        };
        const flaggedResult = await flaggedMessagesStorage.insertOne(flaggedMessage);
        const now = new Date();
        let resolvedSessionId = null;
        if (messagesJobStorage && data.messageId) {
          const messageLookupQuery = ObjectId.isValid(data.messageId)
            ? {
                $or: [{ _id: new ObjectId(data.messageId) }, { clientMessageId: data.messageId }],
              }
            : { clientMessageId: data.messageId };
          const matchedMessage = await messagesJobStorage.findOne(messageLookupQuery);
          if (matchedMessage) {
            resolvedSessionId = matchedMessage.sessionId || null;
            await messagesJobStorage.updateOne(
              { _id: matchedMessage._id },
              {
                $set: {
                  flagTriggered: true,
                  flaggedAt: now,
                  flagReasons: reasonList,
                  flagStatus: 'pending',
                  updatedAt: now,
                },
              }
            );
          }
        }
        if (mateyChatSessionsStorage && resolvedSessionId) {
          await mateyChatSessionsStorage.updateOne(
            { sessionId: resolvedSessionId },
            {
              $set: {
                hasFlaggedMessages: true,
                lastFlaggedAt: now,
                updatedAt: now,
              },
            }
          );
          const flaggedCount = await messagesJobStorage.countDocuments({
            sessionId: resolvedSessionId,
            flagTriggered: true,
          });
          await mateyChatSessionsStorage.updateOne(
            { sessionId: resolvedSessionId },
            {
              $set: {
                flaggedMessageCount: flaggedCount,
                hasFlaggedMessages: flaggedCount > 0,
                lastFlaggedAt: now,
                updatedAt: now,
              },
            }
          );
        }
        await chatLogsStorage.updateMany(
          {
            mateyResponse: data.messageText,
            userEmail: Array.isArray(data.email) ? { $in: data.email } : data.email,
          },
          {
            $set: {
              flagTriggered: true,
              flaggedAt: now,
              flagReasons: reasonList,
              updatedAt: new Date(),
            },
          }
        );
        // Log audit for flagged message
        await auditLogger.logAudit({
          ...auditData,
          resource: 'flagged_message',
          resourceId: flaggedResult.insertedId.toString(),
          newData: {
            messageId: data.messageId,
            reasons: data.feedback.reasons,
            status: 'pending',
          },
        });
      }
      res.status(200).send(feedbackInsertResult);
    } catch (err) {
      console.error('Error adding feedback:', err);
      res.status(500).send({
        error: 'Failed to store feedback',
        details: err.message,
      });
    }
  });

  return router;
};
