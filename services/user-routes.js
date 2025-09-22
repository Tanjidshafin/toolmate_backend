const express = require('express');
const { ObjectId } = require('mongodb');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

module.exports = ({ usersStorage, clerkClient, emailTriggers, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router();

  router.post('/store-user', async (req, res) => {
    try {
      const { userEmail, userName, userImage, role, clerkId } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      const existingUser = await usersStorage.findOne({ userEmail });
      if (existingUser) {
        const oldData = { ...existingUser };
        const updateData = {
          clerkId,
          userName,
          userImage,
          role,
          updatedAt: new Date(),
        };
        const result = await usersStorage.updateOne({ userEmail }, { $set: updateData });
        // Log audit for user update
        await auditLogger.logAudit({
          action: 'UPDATE',
          resource: 'user',
          resourceId: existingUser._id.toString(),
          userId: userEmail,
          userEmail,
          role: role || existingUser.role || 'user',
          oldData,
          newData: updateData,
          ...userInfo,
        });
        res.json({ updated: true, result });
      } else {
        const userData = {
          userEmail,
          userName,
          userImage,
          isSubscribed: false,
          role: role || 'user',
          createdAt: new Date(),
          updatedAt: new Date(),
          clerkId,
        };
        await emailTriggers.triggerWelcomeEmail(userData);
        const result = await usersStorage.insertOne(userData);
        // Log audit for user creation
        await auditLogger.logAudit({
          action: 'CREATE',
          resource: 'user',
          resourceId: result.insertedId.toString(),
          userId: userEmail,
          userEmail,
          role: role || 'user',
          newData: userData,
          ...userInfo,
        });
        res.json({ inserted: true, result });
      }
    } catch (error) {
      console.error('Error storing user:', error);
      res.status(500).json({ error: 'Failed to store user' });
    }
  });
  router.get('/user/:email', async (req, res) => {
    try {
      const { email } = req.params;
      const user = await usersStorage.findOne({ userEmail: email });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      res.json(user);
    } catch (error) {
      console.error('Error fetching user:', error);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  });
  router.get('/admin/users', async (req, res) => {
    try {
      const { page = 1, limit = 20, search, role } = req.query;
      const skip = (page - 1) * limit;
      const query = {};
      if (search) {
        query.$or = [{ userName: { $regex: search, $options: 'i' } }, { userEmail: { $regex: search, $options: 'i' } }];
      }
      if (role) {
        query.role = role;
      }
      const users = await usersStorage
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number.parseInt(limit))
        .toArray();
      const total = await usersStorage.countDocuments(query);
      res.json({
        users,
        pagination: {
          current: Number.parseInt(page),
          total: Math.ceil(total / limit),
          count: total,
        },
      });
    } catch (error) {
      console.error('Error fetching users:', error);
      res.status(500).json({ error: 'Failed to fetch users' });
    }
  });

  router.put('/admin/users/:email', async (req, res) => {
    try {
      const { email } = req.params;
      const { role, isSubscribed, userEmail, userName, password, isBanned, clerkId } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      const existingUser = await usersStorage.findOne({ userEmail: email });
      if (!existingUser) {
        return res.status(404).json({ error: 'User not found in database' });
      }

      const updateData = {
        updatedAt: new Date(),
      };
      if (role !== undefined) updateData.role = role;
      if (isSubscribed !== undefined) updateData.isSubscribed = isSubscribed;
      if (isBanned !== undefined) updateData.isBanned = isBanned;
      if (userName) updateData.userName = userName;
      if (userEmail && userEmail !== email) updateData.userEmail = userEmail;
      if (clerkId && clerkId.trim() !== '') {
        try {
          const currentClerkUser = await clerkClient.users.getUser(clerkId);
          const clerkUpdates = {};
          if (userName) {
            const nameParts = userName.split(' ');
            clerkUpdates.firstName = nameParts[0] || userName;
            clerkUpdates.lastName = nameParts.slice(1).join(' ') || '';
            if (userName !== existingUser.userName) {
              await emailTriggers.triggerNameChangedEmail(email, userName, existingUser.userName, userName);
            }
          }
          if (userEmail && userEmail !== email) {
            try {
              const newEmailAddress = await clerkClient.emailAddresses.createEmailAddress({
                userId: clerkId,
                emailAddress: userEmail,
                verified: true,
              });
              console.log('✅ New email address created:', newEmailAddress.id);
              await clerkClient.users.updateUser(clerkId, {
                primaryEmailAddressId: newEmailAddress.id,
              });
              const oldEmailAddresses = currentClerkUser.emailAddresses.filter((e) => e.emailAddress === email);
              for (const oldEmail of oldEmailAddresses) {
                if (oldEmail.id !== newEmailAddress.id) {
                  try {
                    await clerkClient.emailAddresses.deleteEmailAddress(oldEmail.id);
                    console.log('🗑️ Deleted old email address:', oldEmail.emailAddress);
                  } catch (deleteError) {
                    console.warn('⚠️ Could not delete old email:', deleteError.message);
                  }
                }
              }
              await emailTriggers.triggerEmailChangedEmail(
                userEmail,
                userName || existingUser.userName,
                email,
                userEmail
              );
            } catch (emailError) {
              console.error('❌ Email update failed:', emailError);
            }
          }
          if (password) {
            try {
              await clerkClient.users.updateUser(clerkId, {
                password: password,
              });
              let name = 'user';
              const db = await usersStorage.findOne({ userEmail: email });
              if (db) {
                name = db.userName;
              }
              await emailTriggers.triggerPasswordChangedEmail(email, name);
            } catch (passwordError) {
              console.error('❌ Password update failed:', passwordError);
              throw new Error(`Password update failed: ${passwordError.message}`);
            }
          }
          if (isBanned !== undefined) {
            console.log('🚫 Attempting ban status update to:', isBanned);
            try {
              await clerkClient.users.updateUser(clerkId, {
                banned: isBanned,
              });
              let name = 'user';
              const db = await usersStorage.findOne({ userEmail: email });
              if (db) {
                name = db.userName;
              }
              if (isBanned) {
                await emailTriggers.triggerUserBannedEmail(email, name);
              } else {
                await emailTriggers.triggerUserUnbannedEmail(email, name);
              }
            } catch (banError) {
              throw new Error(`Ban status update failed: ${banError.message}`);
            }
          }
          if (role !== undefined && role !== existingUser.role) {
            await emailTriggers.triggerRoleChangedEmail(
              email,
              userName || existingUser.userName,
              existingUser.role,
              role
            );
          }
          if (isSubscribed !== undefined && isSubscribed === true && existingUser.isSubscribed !== true) {
            await emailTriggers.triggerSubscriptionGiftedEmail(
              email,
              userName || existingUser.userName,
              'Toolmate Admin'
            );
          }
          if (Object.keys(clerkUpdates).length > 0) {
            await clerkClient.users.updateUser(clerkId, clerkUpdates);
          }
          const updatedClerkUser = await clerkClient.users.getUser(clerkId);
        } catch (clerkError) {
          console.error('❌ Clerk update error:', clerkError);
          return res.status(400).json({
            error: 'Failed to update user in Clerk',
            details: clerkError.message || clerkError.toString(),
          });
        }
      }
      const result = await usersStorage.updateOne({ userEmail: email }, { $set: updateData });
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'User not found in database' });
      }

      // Log audit for user update by admin
      await auditLogger.logAudit({
        action: 'UPDATE',
        resource: 'user',
        resourceId: existingUser._id.toString(),
        userId: 'admin', // Admin performing the action
        userEmail: 'admin@toolmate.com',
        role: 'admin',
        oldData: existingUser,
        newData: updateData,
        metadata: {
          targetUser: email,
          updatedFields: Object.keys(updateData),
          adminAction: true,
        },
        ...userInfo,
      });

      res.json({
        message: 'User updated successfully',
        updatedFields: Object.keys(updateData),
      });
    } catch (error) {
      console.error('❌ Error updating user:', error);
      res.status(500).json({ error: 'Failed to update user' });
    }
  });

  router.put('/admin/users/:email/password', async (req, res) => {
    try {
      const { email } = req.params;
      const { password, clerkId } = req.body;
      const userInfo = getUserInfoFromRequest(req);

      if (!clerkId) {
        return res.status(400).json({ error: 'Clerk ID is required for password updates' });
      }
      if (!password || password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters long' });
      }
      try {
        const currentUser = await clerkClient.users.getUser(clerkId);
        await clerkClient.users.updateUser(clerkId, {
          password: password,
        });
        await usersStorage.updateOne(
          { userEmail: email },
          {
            $set: {
              passwordUpdatedAt: new Date(),
              updatedAt: new Date(),
            },
          }
        );
        const user = await usersStorage.findOne({ userEmail: email });
        if (user) {
          await emailTriggers.triggerPasswordChangedEmail(email, user.userName);
        }
        // Log audit for password update by admin
        await auditLogger.logAudit({
          action: 'UPDATE_PASSWORD',
          resource: 'user',
          resourceId: email,
          userId: 'admin',
          userEmail: 'admin@toolmate.com',
          role: 'admin',
          newData: {
            passwordUpdatedAt: new Date(),
            updatedAt: new Date(),
          },
          metadata: {
            targetUser: email,
            adminAction: true,
          },
          ...userInfo,
        });

        res.json({ message: 'Password updated successfully' });
      } catch (clerkError) {
        console.error('❌ Clerk password update error:', clerkError);
        res.status(400).json({
          error: 'Failed to update password in Clerk',
          details: clerkError.message || clerkError.toString(),
        });
      }
    } catch (error) {
      console.error('❌ Error updating password:', error);
      res.status(500).json({ error: 'Failed to update password' });
    }
  });

  router.put('/admin/users/:email/ban', async (req, res) => {
    try {
      const { email } = req.params;
      const { banned, clerkId } = req.body;
      const userInfo = getUserInfoFromRequest(req);

      if (!clerkId) {
        return res.status(400).json({ error: 'Clerk ID is required for ban operations' });
      }
      if (typeof banned !== 'boolean') {
        return res.status(400).json({ error: 'Banned status must be a boolean value' });
      }
      try {
        const currentUser = await clerkClient.users.getUser(clerkId);
        await clerkClient.users.updateUser(clerkId, {
          banned: banned,
        });
        const updatedUser = await clerkClient.users.getUser(clerkId);
        const result = await usersStorage.updateOne(
          { userEmail: email },
          {
            $set: {
              isBanned: banned,
              updatedAt: new Date(),
              bannedAt: banned ? new Date() : null,
            },
          }
        );
        if (result.matchedCount === 0) {
          return res.status(404).json({
            error: 'User not found in database',
            success: false,
          });
        }
        const user = await usersStorage.findOne({ userEmail: email });
        if (user) {
          if (banned) {
            await emailTriggers.triggerUserBannedEmail(email, user.userName);
          } else {
            await emailTriggers.triggerUserUnbannedEmail(email, user.userName);
          }
        }
        // Log audit for ban/unban action
        await auditLogger.logAudit({
          action: banned ? 'BAN_USER' : 'UNBAN_USER',
          resource: 'user',
          resourceId: email,
          userId: 'admin',
          userEmail: 'admin@toolmate.com',
          role: 'admin',
          newData: {
            isBanned: banned,
            bannedAt: banned ? new Date() : null,
          },
          metadata: {
            targetUser: email,
            permitStatus: banned,
            adminAction: true,
          },
          ...userInfo,
        });

        res.json({
          success: true,
          message: `User ${banned ? 'banned' : 'unbanned'} successfully`,
          data: {
            userEmail: email,
            isBanned: banned,
            updatedAt: new Date(), // Corrected variable name
          },
        });
      } catch (clerkError) {
        console.error('❌ Clerk ban update error:', clerkError);
        res.status(400).json({
          error: 'Failed to update ban status in Clerk',
          details: clerkError.message || clerkError.toString(),
        });
      }
    } catch (error) {
      console.error('❌ Error updating ban status:', error);
      res.status(500).json({
        error: 'Failed to update ban status',
        success: false,
      });
    }
  });
  router.delete('/admin/users/:email', async (req, res) => {
    try {
      const userEmail = req.params.email;
      const userInfo = getUserInfoFromRequest(req);
      const existingUser = await usersStorage.findOne({ userEmail });
      if (!existingUser) {
        return res.status(404).json({ message: 'User not found' });
      }
      const result = await usersStorage.deleteOne({ userEmail });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: 'User not found' });
      }
      // Log audit for user deletion
      await auditLogger.logAudit({
        action: 'DELETE',
        resource: 'user',
        resourceId: existingUser._id.toString(),
        userId: 'admin',
        userEmail: 'admin@toolmate.com',
        role: 'admin',
        oldData: existingUser,
        metadata: {
          deletedUser: userEmail,
          adminAction: true,
        },
        ...userInfo,
      });
      res.json({ message: 'User deleted successfully' });
    } catch (error) {
      console.error('Error deleting user:', error);
      res.status(500).json({ message: 'Internal server error' });
    }
  });
  router.put('/api/user/profile/:userEmail', upload.single('userImage'), async (req, res) => {
    try {
      const { userEmail } = req.params;
      const { userName } = req.body;
      const uploadedFile = req.file;
      const userInfo = getUserInfoFromRequest(req);
      if (!userEmail) {
        return res.status(400).json({ error: 'User email is required' });
      }
      const user = await usersStorage.findOne({ userEmail });
      if (!user) {
        return res.status(404).json({ error: 'User not found in database' });
      }
      const updateData = {
        updatedAt: new Date(),
      };
      let newImageUrl = null;
      if (uploadedFile && user.clerkId) {
        try {
          const fileBlob = new Blob([uploadedFile.buffer], { type: uploadedFile.mimetype });
          const updatedUser = await clerkClient.users.updateUserProfileImage(user.clerkId, {
            file: fileBlob,
          });
          newImageUrl = updatedUser.imageUrl;
          updateData.userImage = newImageUrl;
        } catch (clerkImageError) {
          console.error('Error updating user profile image in Clerk:', clerkImageError);
          return res.status(500).json({ error: 'Failed to update profile image' });
        }
      }
      if (userName !== undefined) {
        updateData.userName = userName;
        if (userName !== user.userName) {
          await emailTriggers.triggerNameChangedEmail(userEmail, userName, user.userName, userName);
        }
      }
      if (user.clerkId && userName !== undefined) {
        const clerkUpdates = {};
        const nameParts = userName.split(' ');
        clerkUpdates.firstName = nameParts[0] || userName;
        clerkUpdates.lastName = nameParts.slice(1).join(' ') || '';
        try {
          await clerkClient.users.updateUser(user.clerkId, clerkUpdates);
        } catch (clerkNameError) {
          console.error('Error updating user name in Clerk:', clerkNameError);
        }
      }
      const result = await usersStorage.updateOne({ userEmail }, { $set: updateData });
      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'User not found in database' });
      }
      // Log audit
      await auditLogger.logAudit({
        action: 'UPDATE_PROFILE',
        resource: 'user',
        resourceId: user._id.toString(),
        userId: user.clerkId || userEmail,
        userEmail: userEmail,
        role: user.role || 'user',
        oldData: { userName: user.userName, userImage: user.userImage },
        newData: updateData,
        metadata: {
          updatedFields: Object.keys(updateData),
          source: 'user_profile_page',
          imageUpdated: !!uploadedFile,
        },
        ...userInfo,
      });
      res.json({
        message: 'Profile updated successfully',
        updatedFields: Object.keys(updateData),
        imageUrl: newImageUrl,
      });
    } catch (error) {
      console.error('Error updating user profile:', error);
      res.status(500).json({ error: 'Failed to update user profile' });
    }
  });

  router.post('/admin/users/:email/gift-subscription', async (req, res) => {
    try {
      const { email } = req.params;
      const { giftedBy = 'Toolmate Admin' } = req.body;
      const userInfo = getUserInfoFromRequest(req);

      const user = await usersStorage.findOne({ userEmail: email });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await usersStorage.updateOne(
        { userEmail: email },
        {
          $set: {
            isSubscribed: true,
            subscriptionGiftedAt: new Date(),
            subscriptionGiftedBy: giftedBy,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: 'User not found in database' });
      }

      await emailTriggers.triggerSubscriptionGiftedEmail(email, user.userName, giftedBy);

      await auditLogger.logAudit({
        action: 'GIFT_SUBSCRIPTION',
        resource: 'user',
        resourceId: user._id.toString(),
        userId: 'admin',
        userEmail: 'admin@toolmate.com',
        role: 'admin',
        newData: {
          isSubscribed: true,
          subscriptionGiftedAt: new Date(),
          subscriptionGiftedBy: giftedBy,
        },
        metadata: {
          targetUser: email,
          giftedBy,
          adminAction: true,
        },
        ...userInfo,
      });

      res.json({
        message: 'Subscription gifted successfully',
        giftedBy,
      });
    } catch (error) {
      console.error('❌ Error gifting subscription:', error);
      res.status(500).json({ error: 'Failed to gift subscription' });
    }
  });

  router.post('/admin/post/email', async (req, res) => {
    try {
      const { userName, userEmail, message, subject } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      if (!userName || !userEmail || !message || !subject) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
      }
      await emailTriggers.triggerSystemAlert(userEmail, userName, subject, message);
      await auditLogger.logAudit({
        action: 'SEND_EMAIL',
        resource: 'email',
        resourceId: userEmail,
        userId: 'admin',
        userEmail: 'admin@toolmate.com',
        role: 'admin',
        newData: {
          recipient: userEmail,
          recipientName: userName,
          subject,
          message,
        },
        metadata: {
          emailType: 'custom_admin_email',
          adminAction: true,
        },
        ...userInfo,
      });
      res.status(200).json({ success: true, message: 'Email sent successfully.' });
    } catch (error) {
      console.error('Error sending email:', error);
      res.status(500).json({ success: false, message: 'Failed to send email.' });
    }
  });
  router.post('/email-change-request', async (req, res) => {
    try {
      const { presentEmail, updatedEmail } = req.body;
      if (!presentEmail || !updatedEmail) {
        return res.status(400).json({ error: 'Both present and updated email are required.' });
      }
      const emailBody = `
G’day ToolMate Legend,

Just a quick heads up — we’ve received your request to change the email linked to your ToolMate account. Too easy!

Here’s what we’ve got on file for you:
- Old Email: ${presentEmail}
- New Email: ${updatedEmail}

What’s Next?
- Sit tight — our team will give this a quick look and approve it shortly.
- Once approved, you'll be able to log in using your shiny new email.
- Didn’t make this request? No stress — just flick us a message at contact@toolmate.com.au and we’ll jump on it.

Need a hand with anything else?
Hit reply or give our support crew a buzz — we’re always here to help.

Catch ya soon,  
Matey from ToolMate
    `;
      await emailTriggers.triggerSystemAlert(
        process.env.FROM_EMAIL,
        'Toolmate Owner',
        'Email Change Requested',
        emailBody
      );
      return res.status(200).json({ message: 'Email change request sent successfully.' });
    } catch (error) {
      console.error('Email change request error:', error);
      return res.status(500).json({ error: 'Internal server error. Please try again later.' });
    }
  });
  router.get('/user/:email/limits', async (req, res) => {
    try {
      const { email } = req.params;
      const user = await usersStorage.findOne({ userEmail: email });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const today = new Date();
      const todayDateString = today.toDateString();
      const userLastReset = user.lastLimitReset;
      if (!userLastReset || userLastReset !== todayDateString) {
        const updateData = {
          dailyMessageCount: 0,
          dailyImageUploadCount: 0,
          lastLimitReset: todayDateString,
          updatedAt: new Date(),
        };
        await usersStorage.updateOne({ userEmail: email }, { $set: updateData });
        return res.json({ dailyMessageCount: 0, dailyImageUploadCount: 0 });
      }
      res.json({
        dailyMessageCount: user.dailyMessageCount || 0,
        dailyImageUploadCount: user.dailyImageUploadCount || 0,
      });
    } catch (error) {
      console.error('Error fetching user limits:', error);
      res.status(500).json({ error: 'Failed to fetch user limits' });
    }
  });
  router.put('/user/:email/limits', async (req, res) => {
    try {
      const { email } = req.params;
      const { incrementMessage, incrementImageUpload } = req.body;
      const today = new Date();
      const todayDateString = today.toDateString();
      const user = await usersStorage.findOne({ userEmail: email });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }
      const updateData = { updatedAt: new Date() };
      const needsReset = !user.lastLimitReset || user.lastLimitReset !== todayDateString;
      if (needsReset) {
        updateData.dailyMessageCount = 0;
        updateData.dailyImageUploadCount = 0;
        updateData.lastLimitReset = todayDateString;
      }
      if (incrementMessage) {
        updateData.dailyMessageCount = (needsReset ? 0 : user.dailyMessageCount || 0) + 1;
      }
      if (incrementImageUpload) {
        updateData.dailyImageUploadCount = (needsReset ? 0 : user.dailyImageUploadCount || 0) + 1;
      }
      await usersStorage.updateOne({ userEmail: email }, { $set: updateData });
      res.json({
        dailyMessageCount:
          updateData.dailyMessageCount !== undefined ? updateData.dailyMessageCount : user.dailyMessageCount || 0,
        dailyImageUploadCount:
          updateData.dailyImageUploadCount !== undefined
            ? updateData.dailyImageUploadCount
            : user.dailyImageUploadCount || 0,
      });
    } catch (error) {
      console.error('Error updating user limits:', error);
      res.status(500).json({ error: 'Failed to update user limits' });
    }
  });
  router.put('/admin/users/:email/permit', async (req, res) => {
    try {
      const { email } = req.params;
      const { isPermit } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      if (typeof isPermit !== 'boolean') {
        return res.status(400).json({
          error: 'isPermit must be a boolean value',
          success: false,
        });
      }
      const existingUser = await usersStorage.findOne({ userEmail: email });
      if (!existingUser) {
        return res.status(404).json({
          error: 'User not found in database',
          success: false,
        });
      }
      const updateData = {
        isPermit,
        updatedAt: new Date(),
        permitUpdatedBy: 'admin',
        permitUpdatedAt: new Date(),
      };
      const result = await usersStorage.updateOne({ userEmail: email }, { $set: updateData });
      if (result.matchedCount === 0) {
        return res.status(404).json({
          error: 'User not found in database',
          success: false,
        });
      }
      await auditLogger.logAudit({
        action: isPermit ? 'GRANT_BLOG_PERMIT' : 'REVOKE_BLOG_PERMIT',
        resource: 'user',
        resourceId: existingUser._id.toString(),
        userId: 'admin',
        userEmail: 'admin@toolmate.com',
        role: 'admin',
        oldData: { isPermit: existingUser.isPermit },
        newData: updateData,
        metadata: {
          targetUser: email,
          permitStatus: isPermit,
          adminAction: true,
        },
        ...userInfo,
      });
      if (isPermit && !existingUser.isPermit) {
        try {
          await emailTriggers.triggerSystemAlert(
            email,
            existingUser.userName,
            'Blog Posting Permission Granted',
            `Hi ${existingUser.userName},\n\nGreat news! You now have permission to create and manage blog posts on our platform.\n\nYou can start creating amazing content right away!\n\nBest regards,\nThe Admin Team`
          );
        } catch (emailError) {
          console.warn('Failed to send permit notification email:', emailError);
        }
      }
      res.json({
        success: true,
        message: `Blog permissions ${isPermit ? 'granted to' : 'revoked from'} user successfully`,
        data: {
          userEmail: email,
          isPermit,
          updatedAt: new Date(),
        },
      });
    } catch (error) {
      console.error('❌ Error updating user permit:', error);
      res.status(500).json({
        error: 'Failed to update user permit status',
        success: false,
      });
    }
  });

  return router;
};
