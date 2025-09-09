const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = ({
  feedbackStorage,
  flaggedMessagesStorage,
  auditLogger,
  getUserInfoFromRequest,
  chatLogsStorage,
}) => {
  const router = express.Router();
  router.post('/add-feedback', async (req, res) => {
    try {
      const data = req.body;
      if (!data.messageId || data.messageId === '') {
        console.log('[v0] Missing or empty messageId');
        return res.status(400).send({
          error: 'Missing required field: messageId',
          received: data,
        });
      }
      const userInfo = getUserInfoFromRequest(req);
      const feedbackData = {
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        flagTriggered: Boolean(data.reportStatus && data.feedback?.reasons),
      };
      console.log('[v0] Inserting feedback:', feedbackData);
      const feedbackInsertResult = await feedbackStorage.insertOne(feedbackData);
      console.log('[v0] Feedback inserted with ID:', feedbackInsertResult.insertedId);
      const userEmail =
        data.isLoggedInUser && data.email ? (Array.isArray(data.email) ? data.email[0] : data.email) : 'Anonymous';
      // Prepare audit lg data
      const auditData = {
        action: 'CREATE',
        resource: 'feedback',
        resourceId: feedbackInsertResult.insertedId.toString(),
        userId: userEmail,
        userEmail: userEmail,
        role: data.isLoggedInUser ? 'user' : 'Anonymous',
        newData: {
          messageId: data.messageId,
          reportStatus: data.reportStatus,
          feedback: data.feedback,
        },
        ...userInfo,
      };

      await auditLogger.logAudit(auditData);

      if (data.reportStatus && data.feedback?.reasons) {
        console.log('[v0] Creating flagged message for messageId:', data.messageId);

        const flaggedMessage = {
          messageId: data.messageId,
          messageText: data.messageText,
          messageTimestamp: new Date(data.messageTimestamp),
          reasons: data.feedback.reasons,
          otherReason: data.feedback.otherReason || '',
          userEmail: userEmail,
          isLoggedInUser: Boolean(data.isLoggedInUser),
          status: 'pending',
          adminComments: '',
          flaggedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          softDeleted: false,
          archived: false,
        };

        console.log('[v0] Flagged message data:', flaggedMessage);
        const flaggedResult = await flaggedMessagesStorage.insertOne(flaggedMessage);
        console.log('[v0] Flagged message created with ID:', flaggedResult.insertedId);

        const chatLogUpdateQuery = {
          mateyResponse: data.messageText,
          userEmail: Array.isArray(data.email) ? { $in: data.email } : userEmail,
        };
        console.log('[v0] Updating chat logs with query:', chatLogUpdateQuery);

        const chatLogUpdateResult = await chatLogsStorage.updateMany(chatLogUpdateQuery, {
          $set: {
            flagTriggered: true,
            updatedAt: new Date(),
          },
        });
        console.log('[v0] Chat logs update result:', chatLogUpdateResult);

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
      } else {
        console.log(
          '[v0] No flagged message created - reportStatus:',
          data.reportStatus,
          'reasons:',
          data.feedback?.reasons
        );
      }

      console.log('[v0] Feedback process completed successfully');
      res.status(200).send(feedbackInsertResult);
    } catch (err) {
      console.error('[v0] Error adding feedback:', err);
      res.status(500).send({
        error: 'Failed to store feedback',
        details: err.message,
      });
    }
  });

  router.get('/get-feedback', async (req, res) => {
    try {
      const { page = 1, limit = 20, search = '' } = req.query;
      const query = {
        reportStatus: false,
        feedback: { $in: ['helpful', 'unhelpful'] },
      };
      if (search && search.trim()) {
        query.$and = [
          {
            $or: [
              { messageText: { $regex: search.trim(), $options: 'i' } },
              { email: { $regex: search.trim(), $options: 'i' } },
              { name: { $regex: search.trim(), $options: 'i' } },
            ],
          },
        ];
      }
      const skip = (parseInt(page) - 1) * parseInt(limit);
      const feedbackData = await feedbackStorage
        .find(query, {
          projection: {
            _id: 1,
            messageId: 1,
            messageText: 1,
            messageTimestamp: 1,
            feedback: 1,
            isLoggedInUser: 1,
            name: 1,
            email: 1,
            reportStatus: 1,
          },
        })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .toArray();
      const totalCount = await feedbackStorage.countDocuments(query);
      const totalPages = Math.ceil(totalCount / parseInt(limit));
      res.status(200).send({
        feedback: feedbackData,
        pagination: {
          current: parseInt(page),
          total: totalPages,
          count: totalCount,
          limit: parseInt(limit),
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

  return router;
};
