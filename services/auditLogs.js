class AuditLogger {
  constructor(auditLogsStorage) {
    this.auditLogsStorage = auditLogsStorage;
  }

  /**
   * Log an audit event
   * @param {Object} auditData - The audit data
   * @param {string} auditData.action - The action performed (CREATE, UPDATE, DELETE, etc.)
   * @param {string} auditData.resource - The resource affected (user, tool, session, etc.)
   * @param {string} auditData.resourceId - The ID of the affected resource
   * @param {string} auditData.userId - The ID of the user performing the action
   * @param {string} auditData.userEmail - The email of the user performing the action
   * @param {string} auditData.role - The role of the user performing the action
   * @param {Object} auditData.oldData - The data before the change (for updates)
   * @param {Object} auditData.newData - The data after the change
   * @param {string} auditData.ipAddress - The IP address of the user
   * @param {string} auditData.userAgent - The user agent string
   * @param {Object} auditData.metadata - Additional metadata
   */
  async logAudit({
    action,
    resource,
    resourceId,
    userId,
    userEmail,
    role = 'user',
    oldData = null,
    newData = null,
    ipAddress = null,
    userAgent = null,
    metadata = {},
  }) {
    try {
      const auditEntry = {
        action: action.toUpperCase(),
        resource: resource.toLowerCase(),
        resourceId: resourceId || null,
        userId: userId || null,
        userEmail: userEmail || null,
        role: role.toLowerCase(),
        oldData,
        newData,
        ipAddress,
        userAgent,
        metadata,
        timestamp: new Date(),
        // Add some computed fields for easier querying
        date: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
        month: new Date().toISOString().substring(0, 7), // YYYY-MM format
        year: new Date().getFullYear(),
      };

      await this.auditLogsStorage.insertOne(auditEntry);
      console.log(`✅ Audit logged: ${action} on ${resource} by ${userEmail || 'system'}`);
    } catch (error) {
      console.error('❌ Failed to log audit entry:', error);
      // Don't throw error to avoid breaking the main operation
    }
  }

  /**
   * Get audit logs with pagination and filtering
   */
  async getAuditLogs({
    page = 1,
    limit = 50,
    action = null,
    resource = null,
    userId = null,
    userEmail = null,
    role = null,
    dateFrom = null,
    dateTo = null,
    resourceId = null,
  }) {
    try {
      const skip = (page - 1) * limit;
      const query = {};

      // Build query filters
      if (action) query.action = action.toUpperCase();
      if (resource) query.resource = resource.toLowerCase();
      if (userId) query.userId = userId;
      if (userEmail) query.userEmail = { $regex: userEmail, $options: 'i' };
      if (role) query.role = role.toLowerCase();
      if (resourceId) query.resourceId = resourceId;

      // Date range filter
      if (dateFrom || dateTo) {
        query.timestamp = {};
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
        if (dateTo) query.timestamp.$lte = new Date(dateTo);
      }

      const logs = await this.auditLogsStorage
        .find(query)
        .sort({ timestamp: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray();

      const total = await this.auditLogsStorage.countDocuments(query);

      return {
        logs,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1,
        },
      };
    } catch (error) {
      console.error('❌ Failed to get audit logs:', error);
      throw error;
    }
  }

  /**
   * Get audit statistics
   */
  async getAuditStats(dateFrom = null, dateTo = null) {
    try {
      const matchQuery = {};
      if (dateFrom || dateTo) {
        matchQuery.timestamp = {};
        if (dateFrom) matchQuery.timestamp.$gte = new Date(dateFrom);
        if (dateTo) matchQuery.timestamp.$lte = new Date(dateTo);
      }

      const stats = await this.auditLogsStorage
        .aggregate([
          { $match: matchQuery },
          {
            $group: {
              _id: {
                action: '$action',
                resource: '$resource',
                role: '$role',
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
        ])
        .toArray();

      const actionStats = await this.auditLogsStorage
        .aggregate([
          { $match: matchQuery },
          {
            $group: {
              _id: '$action',
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
        ])
        .toArray();

      const resourceStats = await this.auditLogsStorage
        .aggregate([
          { $match: matchQuery },
          {
            $group: {
              _id: '$resource',
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
        ])
        .toArray();

      const roleStats = await this.auditLogsStorage
        .aggregate([
          { $match: matchQuery },
          {
            $group: {
              _id: '$role',
              count: { $sum: 1 },
            },
          },
          { $sort: { count: -1 } },
        ])
        .toArray();

      const totalLogs = await this.auditLogsStorage.countDocuments(matchQuery);

      return {
        totalLogs,
        actionStats: actionStats.reduce((acc, stat) => {
          acc[stat._id] = stat.count;
          return acc;
        }, {}),
        resourceStats: resourceStats.reduce((acc, stat) => {
          acc[stat._id] = stat.count;
          return acc;
        }, {}),
        roleStats: roleStats.reduce((acc, stat) => {
          acc[stat._id] = stat.count;
          return acc;
        }, {}),
        detailedStats: stats,
      };
    } catch (error) {
      console.error('❌ Failed to get audit statistics:', error);
      throw error;
    }
  }

  /**
   * Get recent activity for a specific user
   */
  async getUserActivity(userId, limit = 20) {
    try {
      const logs = await this.auditLogsStorage.find({ userId }).sort({ timestamp: -1 }).limit(limit).toArray();

      return logs;
    } catch (error) {
      console.error('❌ Failed to get user activity:', error);
      throw error;
    }
  }

  /**
   * Get recent activity for a specific resource
   */
  async getResourceActivity(resource, resourceId, limit = 20) {
    try {
      const logs = await this.auditLogsStorage
        .find({
          resource: resource.toLowerCase(),
          resourceId,
        })
        .sort({ timestamp: -1 })
        .limit(limit)
        .toArray();

      return logs;
    } catch (error) {
      console.error('❌ Failed to get resource activity:', error);
      throw error;
    }
  }

  /**
   * Clean up old audit logs (optional - for maintenance)
   */
  async cleanupOldLogs(daysToKeep = 365) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await this.auditLogsStorage.deleteMany({
        timestamp: { $lt: cutoffDate },
      });

      console.log(`🧹 Cleaned up ${result.deletedCount} old audit logs`);
      return result.deletedCount;
    } catch (error) {
      console.error('❌ Failed to cleanup old audit logs:', error);
      throw error;
    }
  }
}

module.exports = AuditLogger;
