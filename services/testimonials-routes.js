const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = ({ testimonialsStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router();

  router.get('/admin/testimonials', async (req, res) => {
    try {
      const { page = 1, limit = 10, status = 'all' } = req.query;
      const parsedPage = Math.max(1, Number.parseInt(page, 10) || 1);
      const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
      const skip = (parsedPage - 1) * parsedLimit;

      const matchStage = {
        deletedAt: { $exists: false },
      };

      if (status === 'visible') {
        matchStage.isVisible = true;
      } else if (status === 'hidden') {
        matchStage.isVisible = false;
      }

      const [testimonials, total] = await Promise.all([
        testimonialsStorage
          .find(matchStage)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parsedLimit)
          .toArray(),
        testimonialsStorage.countDocuments(matchStage),
      ]);

      res.json({
        testimonials,
        pagination: {
          current: parsedPage,
          pages: Math.ceil(total / parsedLimit),
          total,
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching testimonials:', error);
      res.status(500).json({ error: 'Failed to fetch testimonials' });
    }
  });

  router.put('/admin/testimonials/:id/visibility', async (req, res) => {
    try {
      const { id } = req.params;
      const { isVisible, moderatorEmail } = req.body;
      const userInfo = getUserInfoFromRequest(req);

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid testimonial ID format' });
      }

      if (typeof isVisible !== 'boolean') {
        return res.status(400).json({ error: 'isVisible must be a boolean' });
      }

      const updateData = {
        isVisible,
        moderatedAt: new Date(),
        moderatedBy: moderatorEmail || 'admin',
        updatedAt: new Date(),
      };

      const result = await testimonialsStorage.updateOne(
        { _id: new ObjectId(id), deletedAt: { $exists: false } },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Testimonial not found' });
      }

      await auditLogger.logAudit({
        action: 'UPDATE_TESTIMONIAL_VISIBILITY',
        resource: 'testimonial',
        resourceId: id,
        userId: moderatorEmail || 'admin',
        userEmail: moderatorEmail || 'admin@toolmate.com',
        role: 'admin',
        newData: updateData,
        ...userInfo,
      });

      return res.json({ success: true, updated: true });
    } catch (error) {
      console.error('Error updating testimonial visibility:', error);
      return res.status(500).json({ error: 'Failed to update testimonial visibility' });
    }
  });

  router.delete('/admin/testimonials/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { moderatorEmail } = req.body || {};
      const userInfo = getUserInfoFromRequest(req);

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid testimonial ID format' });
      }

      const deleteData = {
        deletedAt: new Date(),
        deletedBy: moderatorEmail || 'admin',
        updatedAt: new Date(),
        isVisible: false,
      };

      const result = await testimonialsStorage.updateOne(
        { _id: new ObjectId(id), deletedAt: { $exists: false } },
        { $set: deleteData }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'Testimonial not found' });
      }

      await auditLogger.logAudit({
        action: 'DELETE_TESTIMONIAL',
        resource: 'testimonial',
        resourceId: id,
        userId: moderatorEmail || 'admin',
        userEmail: moderatorEmail || 'admin@toolmate.com',
        role: 'admin',
        newData: deleteData,
        ...userInfo,
      });

      return res.json({ success: true, deleted: true });
    } catch (error) {
      console.error('Error deleting testimonial:', error);
      return res.status(500).json({ error: 'Failed to delete testimonial' });
    }
  });

  router.get('/public/testimonials', async (req, res) => {
    try {
      const { limit = 10 } = req.query;
      const parsedLimit = Math.max(1, Math.min(30, Number.parseInt(limit, 10) || 10));

      const testimonials = await testimonialsStorage
        .find(
          {
            isVisible: true,
            deletedAt: { $exists: false },
          },
          {
            projection: {
              userName: 1,
              userEmail: 1,
              rating: 1,
              review: 1,
              location: 1,
              userImage: 1,
              createdAt: 1,
              isVisible: 1,
            },
          }
        )
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .toArray();

      return res.json({
        testimonials,
        count: testimonials.length,
      });
    } catch (error) {
      console.error('Error fetching public testimonials:', error);
      return res.status(500).json({ error: 'Failed to fetch public testimonials' });
    }
  });

  return router;
};
