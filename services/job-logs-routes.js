const express = require('express');
const router = express.Router();

module.exports = (dependencies) => {
  const { chatLogsStorage, usersStorage, auditLogger, ObjectId, getUserInfoFromRequest } = dependencies;
  router.get('/job-logs/:userId', async (req, res) => {
    try {
      const { userId } = req.params;
      const { page = 1, limit = 100 } = req.query;
      const skip = (page - 1) * limit;
      const query = {
        $or: [
          { userEmail: userId },
          { userEmail: { $in: [userId] } },
        ],
      };
      const logs = await chatLogsStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray();
      const total = await chatLogsStorage.countDocuments(query);
      const userInfo = getUserInfoFromRequest(req);
      await auditLogger.logAudit({
        action: 'VIEW_JOB_LOGS',
        resource: 'job_log',
        resourceId: userId,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        metadata: {
          page: Number.parseInt(page),
          limit: Number.parseInt(limit),
          totalLogsFetched: logs.length,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      });

      res.json({
        success: true,
        jobLogs: logs,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching user job logs:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch job logs' });
    }
  });
  router.get('/admin/job-logs', async (req, res) => {
    try {
      const { page = 1, limit = 20, search, userId, dateFrom, dateTo } = req.query;
      const skip = (page - 1) * limit;
      const userInfo = getUserInfoFromRequest(req);
      const query = {};
      if (search) {
        query.$or = [
          { userName: { $regex: search, $options: 'i' } },
          { userEmail: { $regex: search, $options: 'i' } },
          { prompt: { $regex: search, $options: 'i' } },
          { mateyResponse: { $regex: search, $options: 'i' } },
        ];
      }
      if (userId) {
        query.$or = [{ userEmail: userId }, { userEmail: { $in: [userId] } }];
      }
      if (dateFrom || dateTo) {
        query.timestamp = {};
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
        if (dateTo) query.timestamp.$lte = new Date(dateTo);
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
      await auditLogger.logAudit({
        action: 'ADMIN_VIEW_JOB_LOGS',
        resource: 'job_log',
        resourceId: 'all',
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        metadata: {
          page: Number.parseInt(page),
          limit: Number.parseInt(limit),
          searchQuery: search,
          filterUserId: userId,
          totalLogsFetched: enrichedLogs.length,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      });

      res.json({
        jobLogs: enrichedLogs,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching admin job logs:', error);
      res.status(500).json({ error: 'Failed to fetch admin job logs' });
    }
  });
  // Admin: Update notes for a specific job log
  router.put('/admin/job-logs/:id/notes', async (req, res) => {
    try {
      const { id } = req.params;
      const { notes } = req.body;
      const userInfo = getUserInfoFromRequest(req);

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid job log ID format' });
      }

      const existingLog = await chatLogsStorage.findOne({ _id: new ObjectId(id) });
      if (!existingLog) {
        return res.status(404).json({ error: 'Job log not found' });
      }

      const updateData = {
        'metadata.notes': notes, // Assuming notes are stored in metadata
        updatedAt: new Date(),
      };

      const result = await chatLogsStorage.updateOne({ _id: new ObjectId(id) }, { $set: updateData });

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Job log not found or not updated' });
      }
      // Log audit for job log notes update
      await auditLogger.logAudit({
        action: 'UPDATE_JOB_LOG_NOTES',
        resource: 'job_log',
        resourceId: id,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        oldData: { notes: existingLog.metadata?.notes },
        newData: { notes: notes },
        metadata: {
          targetSessionId: existingLog.sessionId,
          adminAction: true,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      });

      res.json({ success: true, message: 'Job log notes updated successfully' });
    } catch (error) {
      console.error('Error updating job log notes:', error);
      res.status(500).json({ error: 'Failed to update job log notes' });
    }
  });
  // Admin: Delete a specific job log
  router.delete('/admin/job-logs/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const userInfo = getUserInfoFromRequest(req);
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid job log ID format' });
      }
      const existingLog = await chatLogsStorage.findOne({ _id: new ObjectId(id) });
      if (!existingLog) {
        return res.status(404).json({ error: 'Job log not found' });
      }
      const result = await chatLogsStorage.deleteOne({ _id: new ObjectId(id) });
      if (result.deletedCount === 0) {
        return res.status(404).json({ error: 'Job log not found or not deleted' });
      }
      // Log audit for job log deletion
      await auditLogger.logAudit({
        action: 'DELETE_JOB_LOG',
        resource: 'job_log',
        resourceId: id,
        userId: userInfo.userId,
        userEmail: userInfo.userEmail,
        role: userInfo.role,
        oldData: existingLog,
        metadata: {
          targetSessionId: existingLog.sessionId,
          adminAction: true,
        },
        ipAddress: userInfo.ipAddress,
        userAgent: userInfo.userAgent,
      });
      res.json({ success: true, message: 'Job log deleted successfully' });
    } catch (error) {
      console.error('Error deleting job log:', error);
      res.status(500).json({ error: 'Failed to delete job log' });
    }
  });

  return router;
};
