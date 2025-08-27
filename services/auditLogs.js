class AuditLogger {
  constructor(auditLogsStorage) {
    this.auditLogsStorage = auditLogsStorage;
  }
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
        date: new Date().toISOString().split('T')[0],
        month: new Date().toISOString().substring(0, 7),
        year: new Date().getFullYear(),
      };

      await this.auditLogsStorage.insertOne(auditEntry);
      console.log(`✅ Audit logged: ${action} on ${resource} by ${userEmail || 'system'}`);
    } catch (error) {
      console.error('❌ Failed to log audit entry:', error);
    }
  }

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
    lightweight = false, // Added lightweight parameter for optimized loading
  }) {
    try {
      const skip = (page - 1) * limit;
      const query = {};

      if (action) query.action = action.toUpperCase();
      if (resource) query.resource = resource.toLowerCase();
      if (userId) query.userId = userId;
      if (userEmail) query.userEmail = { $regex: userEmail, $options: 'i' };
      if (role) query.role = role.toLowerCase();
      if (resourceId) query.resourceId = resourceId;

      if (dateFrom || dateTo) {
        query.timestamp = {};
        if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
        if (dateTo) query.timestamp.$lte = new Date(dateTo);
      }

      const projection = lightweight
        ? {
            oldData: 0,
            newData: 0,
            metadata: 0,
          }
        : {};

      const logs = await this.auditLogsStorage
        .find(query, { projection })
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

  async getAuditLogDetails(id) {
    try {
      const { ObjectId } = require('mongodb');
      const log = await this.auditLogsStorage.findOne({ _id: new ObjectId(id) });

      if (!log) {
        throw new Error('Audit log not found');
      }

      return log;
    } catch (error) {
      console.error('❌ Failed to get audit log details:', error);
      throw error;
    }
  }

  async getAvailableActions() {
    try {
      const actions = await this.auditLogsStorage.distinct('action');
      return actions.sort();
    } catch (error) {
      console.error('❌ Failed to get available actions:', error);
      throw error;
    }
  }

  async getAvailableResources() {
    try {
      const resources = await this.auditLogsStorage.distinct('resource');
      return resources.sort();
    } catch (error) {
      console.error('❌ Failed to get available resources:', error);
      throw error;
    }
  }

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

  async getUserActivity(userId, limit = 20) {
    try {
      const logs = await this.auditLogsStorage.find({ userId }).sort({ timestamp: -1 }).limit(limit).toArray();
      return logs;
    } catch (error) {
      console.error('❌ Failed to get user activity:', error);
      throw error;
    }
  }

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
