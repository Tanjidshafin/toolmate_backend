const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = ({ redirectTrackingStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router();

  router.post('/track-redirect', async (req, res) => {
    try {
      const userInfo = getUserInfoFromRequest(req);
      const trackingData = {
        toolId: req.body.toolId,
        toolName: req.body.toolName,
        userEmail: req.body.userEmail,
        sessionId: req.body.sessionId,
        timestamp: new Date(),
        price: req.body.price,
        category: req.body.category,
        budgetTier: req.body.budgetTier,
        url: req.body.url,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      };
      await redirectTrackingStorage.insertOne(trackingData);

      // Log audit for redirect tracking
      await auditLogger.logAudit({
        action: 'TRACK_REDIRECT',
        resource: 'tool_redirect',
        resourceId: req.body.toolId,
        userId: req.body.userEmail,
        userEmail: req.body.userEmail,
        role: 'user',
        newData: trackingData,
        ...userInfo,
      });

      res.json({ success: true });
    } catch (error) {
      console.error('Error tracking redirect:', error);
      res.status(500).json({ error: 'Failed to track redirect' });
    }
  });

  router.get('/admin/redirect-tracking', async (req, res) => {
    try {
      const { page = 1, limit = 50, toolId, dateFrom, dateTo } = req.query;
      const skip = (page - 1) * limit;
      const query = {};
      if (toolId) query.toolId = toolId;
      if (dateFrom || dateTo) {
        query.timestamp = {};
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
        if (dateTo) query.timestamp.$lte = new Date(dateTo);
      }
      const tracking = await redirectTrackingStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray();
      const total = await redirectTrackingStorage.countDocuments(query);
      const clickStats = await redirectTrackingStorage
        .aggregate([
          { $match: query },
          {
            $group: {
              _id: '$toolName',
              clicks: { $sum: 1 },
              toolId: { $first: '$toolId' },
            },
          },
          { $sort: { clicks: -1 } },
        ])
        .toArray();
      res.json({
        tracking,
        clickStats,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching redirect tracking:', error);
      res.status(500).json({ error: 'Failed to fetch redirect tracking' });
    }
  });

  return router;
};
