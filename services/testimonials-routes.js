const express = require('express');
const { ObjectId } = require('mongodb');

const ALLOWED_STATUSES = new Set(['pending', 'approved', 'rejected']);

const getNormalizedStatus = (testimonial = {}) => {
  if (ALLOWED_STATUSES.has(testimonial.status)) {
    return testimonial.status;
  }

  return testimonial.isVisible ? 'approved' : 'pending';
};

const normalizeTestimonial = (testimonial = {}) => {
  const normalizedStatus = getNormalizedStatus(testimonial);

  return {
    ...testimonial,
    status: normalizedStatus,
    isVisible: normalizedStatus === 'approved',
  };
};

const sanitizeString = (value = '', maxLength = 500) => {
  return String(value).trim().replace(/\s+/g, ' ').slice(0, maxLength);
};

const isValidEmail = (email = '') => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim().toLowerCase());
};

const normalizeImageUrl = (value = '') => {
  const normalized = sanitizeString(value || '', 2048);
  if (!normalized) {
    return '';
  }

  if (normalized.startsWith('data:')) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }

    return parsed.toString();
  } catch (_error) {
    return '';
  }
};

module.exports = ({ testimonialsStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router();

  router.post('/add-testimonial', async (req, res) => {
    try {
      const {
        userName,
        userEmail,
        rating,
        review,
        location,
        userImage,
        isLoggedInUser = false,
        guestToken,
        triggerSource,
        triggeredAfterResponseCount,
        sessionId,
      } = req.body || {};

      const userInfo = getUserInfoFromRequest(req);
      const normalizedEmail = sanitizeString(userEmail || '', 160).toLowerCase();
      const normalizedName = sanitizeString(userName || '', 100);
      const normalizedLocation = sanitizeString(location || '', 140);
      const normalizedReview = sanitizeString(review || '', 500);
      const normalizedGuestToken = sanitizeString(guestToken || '', 128);
      const normalizedImage = normalizeImageUrl(userImage || '');
      const numericRating = Number.parseInt(rating, 10);
      const responseCount = Number.parseInt(triggeredAfterResponseCount, 10);

      if (!normalizedName) {
        return res.status(400).json({ error: 'Name is required' });
      }

      if (!normalizedReview) {
        return res.status(400).json({ error: 'Review is required' });
      }

      if (!Number.isInteger(numericRating) || numericRating < 1 || numericRating > 5) {
        return res.status(400).json({ error: 'Rating must be an integer between 1 and 5' });
      }

      if (isLoggedInUser) {
        if (!normalizedEmail || !isValidEmail(normalizedEmail)) {
          return res.status(400).json({ error: 'A valid email is required for logged in users' });
        }
      } else if (!normalizedEmail && !normalizedGuestToken) {
        return res.status(400).json({ error: 'Guest users must provide email or guest token' });
      }

      if (normalizedEmail && !isValidEmail(normalizedEmail)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      if (userImage && !normalizedImage) {
        return res.status(400).json({ error: 'Invalid userImage URL. Please upload a valid image.' });
      }

      const duplicateQuery = {
        deletedAt: { $exists: false },
        status: { $in: ['pending', 'approved'] },
      };

      if (normalizedEmail) {
        duplicateQuery.userEmail = normalizedEmail;
      } else {
        duplicateQuery.guestToken = normalizedGuestToken;
      }

      const existing = await testimonialsStorage.findOne(duplicateQuery, {
        projection: { _id: 1, status: 1 },
      });

      if (existing) {
        return res.status(409).json({
          error: existing.status === 'approved' ? 'You already have an approved testimonial' : 'Your testimonial is pending review',
          status: existing.status,
        });
      }

      const now = new Date();
      const testimonialDoc = {
        userName: normalizedName,
        userEmail: normalizedEmail || 'guest@toolmate.local',
        rating: numericRating,
        review: normalizedReview,
        location: normalizedLocation || undefined,
        userImage: normalizedImage || undefined,
        isLoggedInUser: !!isLoggedInUser,
        guestToken: !isLoggedInUser ? normalizedGuestToken || undefined : undefined,
        triggerSource: sanitizeString(triggerSource || 'matey-response-3', 64),
        triggeredAfterResponseCount: Number.isInteger(responseCount) ? responseCount : undefined,
        sessionId: sanitizeString(sessionId || '', 120) || undefined,
        status: 'pending',
        isVisible: false,
        createdAt: now,
        updatedAt: now,
      };

      const result = await testimonialsStorage.insertOne(testimonialDoc);

      await auditLogger.logAudit({
        action: 'CREATE_TESTIMONIAL',
        resource: 'testimonial',
        resourceId: result.insertedId.toString(),
        userId: normalizedEmail || normalizedGuestToken || 'guest',
        userEmail: normalizedEmail || 'guest@toolmate.local',
        role: 'user',
        newData: {
          rating: testimonialDoc.rating,
          status: testimonialDoc.status,
          isLoggedInUser: testimonialDoc.isLoggedInUser,
          triggerSource: testimonialDoc.triggerSource,
        },
        ...userInfo,
      });

      return res.status(201).json({
        success: true,
        testimonialId: result.insertedId,
        status: 'pending',
        message: 'Thanks for sharing. Your testimonial is pending admin approval.',
      });
    } catch (error) {
      console.error('Error creating testimonial:', error);
      return res.status(500).json({ error: 'Failed to submit testimonial' });
    }
  });

  const handleCheckUserReview = async (req, res) => {
    try {
      const emailParam = sanitizeString(req.params.email || '', 160).toLowerCase();
      const guestToken = sanitizeString(req.query.guestToken || '', 128);

      if (!emailParam && !guestToken) {
        return res.status(400).json({ error: 'Email or guest token is required' });
      }

      if (emailParam && !isValidEmail(emailParam)) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      const identityFilter = emailParam ? { userEmail: emailParam } : { guestToken };
      const existing = await testimonialsStorage.findOne(
        {
          ...identityFilter,
          deletedAt: { $exists: false },
        },
        {
          projection: {
            _id: 1,
            status: 1,
            isVisible: 1,
            createdAt: 1,
            moderatedAt: 1,
          },
          sort: { createdAt: -1 },
        }
      );

      if (!existing) {
        return res.json({
          hasReview: false,
          hasApprovedReview: false,
          shouldSuppressInvite: false,
          status: null,
          testimonialId: null,
        });
      }

      const normalized = normalizeTestimonial(existing);
      const hasReview = true;
      const hasApprovedReview = normalized.status === 'approved';

      return res.json({
        hasReview,
        hasApprovedReview,
        shouldSuppressInvite: hasReview,
        status: normalized.status,
        testimonialId: normalized._id,
        createdAt: normalized.createdAt,
        moderatedAt: normalized.moderatedAt || null,
      });
    } catch (error) {
      console.error('Error checking testimonial status:', error);
      return res.status(500).json({ error: 'Failed to check testimonial status' });
    }
  };

  router.get('/check-user-review', handleCheckUserReview);
  router.get('/check-user-review/:email', handleCheckUserReview);

  router.get('/admin/testimonials', async (req, res) => {
    try {
      const { page = 1, limit = 10, status = 'all' } = req.query;
      const parsedPage = Math.max(1, Number.parseInt(page, 10) || 1);
      const parsedLimit = Math.max(1, Math.min(100, Number.parseInt(limit, 10) || 10));
      const skip = (parsedPage - 1) * parsedLimit;
      const normalizedStatusFilter = String(status || 'all').toLowerCase();

      const matchStage = {
        deletedAt: { $exists: false },
      };

      if (normalizedStatusFilter === 'approved' || normalizedStatusFilter === 'visible') {
        matchStage.$or = [{ status: 'approved' }, { status: { $exists: false }, isVisible: true }];
      } else if (normalizedStatusFilter === 'pending') {
        matchStage.$or = [{ status: 'pending' }, { status: { $exists: false }, isVisible: { $ne: true } }];
      } else if (normalizedStatusFilter === 'rejected') {
        matchStage.status = 'rejected';
      } else if (normalizedStatusFilter === 'hidden') {
        matchStage.$or = [{ status: { $in: ['pending', 'rejected'] } }, { status: { $exists: false }, isVisible: false }];
      }

      const [rawTestimonials, total] = await Promise.all([
        testimonialsStorage
          .find(matchStage)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parsedLimit)
          .toArray(),
        testimonialsStorage.countDocuments(matchStage),
      ]);

      const testimonials = rawTestimonials.map(normalizeTestimonial);

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

  router.put('/admin/testimonials/:id/status', async (req, res) => {
    try {
      const { id } = req.params;
      const { status, moderatorEmail, rejectionReason } = req.body || {};
      const userInfo = getUserInfoFromRequest(req);
      const normalizedStatus = sanitizeString(status || '', 16).toLowerCase();

      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid testimonial ID format' });
      }

      if (!ALLOWED_STATUSES.has(normalizedStatus)) {
        return res.status(400).json({ error: 'status must be pending, approved, or rejected' });
      }

      const updateData = {
        status: normalizedStatus,
        isVisible: normalizedStatus === 'approved',
        moderatedAt: new Date(),
        moderatedBy: moderatorEmail || 'admin',
        rejectionReason: normalizedStatus === 'rejected' ? sanitizeString(rejectionReason || '', 300) : undefined,
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
        action: 'UPDATE_TESTIMONIAL_STATUS',
        resource: 'testimonial',
        resourceId: id,
        userId: moderatorEmail || 'admin',
        userEmail: moderatorEmail || 'admin@toolmate.com',
        role: 'admin',
        newData: updateData,
        ...userInfo,
      });

      return res.json({ success: true, updated: true, status: normalizedStatus });
    } catch (error) {
      console.error('Error updating testimonial status:', error);
      return res.status(500).json({ error: 'Failed to update testimonial status' });
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
        status: isVisible ? 'approved' : 'pending',
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
        status: 'rejected',
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
            $or: [{ status: 'approved' }, { status: { $exists: false }, isVisible: true }],
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
              status: 1,
            },
          }
        )
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .toArray();

      const normalizedTestimonials = testimonials.map(normalizeTestimonial);

      return res.json({
        testimonials: normalizedTestimonials,
        count: normalizedTestimonials.length,
      });
    } catch (error) {
      console.error('Error fetching public testimonials:', error);
      return res.status(500).json({ error: 'Failed to fetch public testimonials' });
    }
  });

  return router;
};
