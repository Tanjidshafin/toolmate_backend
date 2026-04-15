const express = require('express');

const buildFeedbackQuery = (search) => {
  const query = {
    feedback: { $type: 'string' },
    reportStatus: { $ne: true },
  };

  if (search && search.trim() !== '') {
    const searchRegex = {
      $regex: search.trim(),
      $options: 'i',
    };

    query.$or = [
      { messageText: searchRegex },
      { name: searchRegex },
      { email: searchRegex },
    ];
  }

  return query;
};

module.exports = ({
  feedbackStorage,
  flaggedMessagesStorage,
  auditLogger,
  getUserInfoFromRequest,
  chatLogsStorage,
}) => {
  const router = express.Router();

  router.get('/get-feedback', async (req, res) => {
    try {
      const { page = 1, limit = 20, search } = req.query;
      const numericPage = Math.max(Number.parseInt(page, 10) || 1, 1);
      const numericLimit = Math.max(Number.parseInt(limit, 10) || 20, 1);
      const skip = (numericPage - 1) * numericLimit;
      const query = buildFeedbackQuery(search);

      const [feedback, total] = await Promise.all([
        feedbackStorage
          .aggregate([
            { $match: query },
            {
              $addFields: {
                sortDate: {
                  $ifNull: [
                    '$createdAt',
                    {
                      $convert: {
                        input: '$messageTimestamp',
                        to: 'date',
                        onError: null,
                        onNull: null,
                      },
                    },
                  ],
                },
              },
            },
            { $sort: { sortDate: -1, _id: -1 } },
            { $skip: skip },
            { $limit: numericLimit },
            { $project: { sortDate: 0 } },
          ])
          .toArray(),
        feedbackStorage.countDocuments(query),
      ]);

      res.status(200).json({
        feedback,
        pagination: {
          current: numericPage,
          total: Math.ceil(total / numericLimit),
          count: total,
        },
      });
    } catch (err) {
      console.error('Error fetching feedback:', err);
      res.status(500).json({
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
      const feedbackInsertResult = await feedbackStorage.insertOne({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        flagTriggered: Boolean(data.reportStatus && data.feedback?.reasons),
      });
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
        const flaggedMessage = {
          messageId: data.messageId,
          messageText: data.messageText,
          messageTimestamp: new Date(data.messageTimestamp),
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
        };
        const flaggedResult = await flaggedMessagesStorage.insertOne(flaggedMessage);
        await chatLogsStorage.updateMany(
          {
            mateyResponse: data.messageText,
            userEmail: Array.isArray(data.email) ? { $in: data.email } : data.email,
          },
          {
            $set: {
              flagTriggered: true,
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
