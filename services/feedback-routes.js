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
      const userInfo = getUserInfoFromRequest(req);
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

        // Log audit for feedback creation
        await auditLogger.logAudit({
          action: 'CREATE',
          resource: 'feedback',
          resourceId: result.insertedId.toString(),
          userId: data.email?.[0] || data.email,
          userEmail: data.email?.[0] || data.email,
          role: data.isLoggedInUser ? 'user' : 'anonymous',
          newData: {
            messageId: data.messageId,
            reportStatus: data.reportStatus,
            feedback: data.feedback,
          },
          ...userInfo,
        });

        if (data.reportStatus && data.feedback && data.feedback.reasons) {
          const flaggedResult = await flaggedMessagesStorage.insertOne({
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
          const existingLog = await chatLogsStorage.findOne({ mateyResponse: messageText });
          if (existingLog) {
            await chatLogsStorage.updateOne(
              { mateyResponse: messageText },
              {
                $set: {
                  flagTriggered: true,
                },
              }
            );
          }

          // Log audit for flagged message creation
          await auditLogger.logAudit({
            action: 'CREATE',
            resource: 'flagged_message',
            resourceId: flaggedResult.insertedId.toString(),
            userId: data.email?.[0] || data.email,
            userEmail: data.email?.[0] || data.email,
            role: data.isLoggedInUser ? 'user' : 'anonymous',
            newData: {
              messageId: data.messageId,
              reasons: data.feedback.reasons,
              status: 'pending',
            },
            ...userInfo,
          });
        }
        res.status(200).send(result);
      }
    } catch (err) {
      console.error('Error adding feedback:', err);
      res.status(500).send({ error: 'Failed to store feedback' });
    }
  });

  return router;
};
