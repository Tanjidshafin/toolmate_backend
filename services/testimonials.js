const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = ({ testimonialsStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router();
  router.post('/add-testimonial', async (req, res) => {
    try {
      const data = req.body;
      const userInfo = getUserInfoFromRequest(req);
      const existingTestimonial = await testimonialsStorage.findOne({
        userEmail: data.userEmail,
      });

      if (existingTestimonial) {
        return res.status(400).send({
          message: 'You have already submitted a review. Only one review per user is allowed.',
        });
      }
      const testimonialData = {
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        isVisible: false,
        moderatedAt: null,
        moderatedBy: null,
      };
      const insertResult = await testimonialsStorage.insertOne(testimonialData);
      const auditData = {
        action: 'CREATE',
        resource: 'testimonial',
        resourceId: insertResult.insertedId.toString(),
        userId: data.userEmail,
        userEmail: data.userEmail,
        role: data.isLoggedInUser ? 'user' : 'anonymous',
        newData: {
          rating: data.rating,
          review: data.review,
          userName: data.userName,
        },
        ...userInfo,
      };
      await auditLogger.logAudit(auditData);
      res.status(200).send({
        success: true,
        message: 'Thank you for your review! It will be visible after moderation.',
        testimonialId: insertResult.insertedId,
      });
    } catch (err) {
      console.error('Error adding testimonial:', err);
      res.status(500).send({
        error: 'Failed to store testimonial',
        details: err.message,
      });
    }
  });
  router.get('/admin/testimonials', async (req, res) => {
    try {
      const { page = 1, limit = 10, status } = req.query;
      const skip = (page - 1) * limit;
      const filter = {};
      if (status === 'visible') {
        filter.isVisible = true;
      } else if (status === 'hidden') {
        filter.isVisible = false;
      }
      const testimonials = await testimonialsStorage
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray();
      const total = await testimonialsStorage.countDocuments(filter);
      res.status(200).send({
        testimonials,
        pagination: {
          page: Number.parseInt(page),
          limit: Number.parseInt(limit),
          total,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      console.error('Error fetching testimonials:', err);
      res.status(500).send({
        error: 'Failed to fetch testimonials',
        details: err.message,
      });
    }
  });
  router.get('/public/testimonials', async (req, res) => {
    try {
      const { limit = 10 } = req.query;
      const testimonials = await testimonialsStorage
        .find({ isVisible: true })
        .sort({ createdAt: -1 })
        .limit(Number.parseInt(limit))
        .toArray();

      res.status(200).send({
        testimonials,
      });
    } catch (err) {
      console.error('Error fetching public testimonials:', err);
      res.status(500).send({
        error: 'Failed to fetch testimonials',
        details: err.message,
      });
    }
  });
  router.put('/admin/testimonials/:id/visibility', async (req, res) => {
    try {
      const { id } = req.params;
      const { isVisible, moderatorEmail } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      const updateResult = await testimonialsStorage.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            isVisible: Boolean(isVisible),
            moderatedAt: new Date(),
            moderatedBy: moderatorEmail,
            updatedAt: new Date(),
          },
        }
      );
      if (updateResult.matchedCount === 0) {
        return res.status(404).send({ message: 'Testimonial not found' });
      }
      // Log audit
      const auditData = {
        action: 'UPDATE',
        resource: 'testimonial',
        resourceId: id,
        userId: moderatorEmail,
        userEmail: moderatorEmail,
        role: 'admin',
        newData: {
          isVisible: Boolean(isVisible),
          moderatedBy: moderatorEmail,
        },
        ...userInfo,
      };
      await auditLogger.logAudit(auditData);
      res.status(200).send({
        success: true,
        message: `Testimonial ${isVisible ? 'approved' : 'hidden'} successfully`,
      });
    } catch (err) {
      console.error('Error updating testimonial visibility:', err);
      res.status(500).send({
        error: 'Failed to update testimonial',
        details: err.message,
      });
    }
  });
  router.delete('/admin/testimonials/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { moderatorEmail } = req.body;
      const userInfo = getUserInfoFromRequest(req);

      const testimonial = await testimonialsStorage.findOne({ _id: new ObjectId(id) });
      if (!testimonial) {
        return res.status(404).send({ message: 'Testimonial not found' });
      }
      const deleteResult = await testimonialsStorage.deleteOne({ _id: new ObjectId(id) });
      if (deleteResult.deletedCount === 0) {
        return res.status(404).send({ message: 'Testimonial not found' });
      }
      // Log audit
      const auditData = {
        action: 'DELETE',
        resource: 'testimonial',
        resourceId: id,
        userId: moderatorEmail,
        userEmail: moderatorEmail,
        role: 'admin',
        oldData: {
          rating: testimonial.rating,
          review: testimonial.review,
          userName: testimonial.userName,
          userEmail: testimonial.userEmail,
        },
        ...userInfo,
      };
      await auditLogger.logAudit(auditData);

      res.status(200).send({
        success: true,
        message: 'Testimonial deleted successfully',
      });
    } catch (err) {
      console.error('Error deleting testimonial:', err);
      res.status(500).send({
        error: 'Failed to delete testimonial',
        details: err.message,
      });
    }
  });
  router.get('/check-user-review/:email', async (req, res) => {
    try {
      const { email } = req.params;

      const existingTestimonial = await testimonialsStorage.findOne({
        userEmail: email,
      });

      res.status(200).send({
        hasReview: !!existingTestimonial,
        testimonial: existingTestimonial || null,
      });
    } catch (err) {
      console.error('Error checking user review:', err);
      res.status(500).send({
        error: 'Failed to check user review',
        details: err.message,
      });
    }
  });

  return router;
};
