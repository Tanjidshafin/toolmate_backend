const express = require('express');
const bcrypt = require('bcrypt');
const { ObjectId } = require('mongodb');

module.exports = ({ auditLogger, getUserInfoFromRequest, emailTriggers, adminCredentialsStorage }) => {
  const router = express.Router();
  router.post('/api/v1/admin/login', async (req, res) => {
    try {
      const { username, password } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: 'Username (email) and password are required',
        });
      }
      const adminCredential = await adminCredentialsStorage.findOne({ userEmail: username });
      if (!adminCredential) {
        auditLogger.logAudit({
          action: 'LOGIN_FAILED',
          resource: 'admin_session',
          resourceId: null,
          userId: username,
          userEmail: username,
          role: 'unknown',
          newData: {
            attemptTime: new Date(),
            username: username,
          },
          metadata: {
            adminAction: false,
            loginSuccess: false,
            failureReason: 'user_not_found',
          },
          ...userInfo,
        });
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
        });
      }
      const isPasswordValid = await bcrypt.compare(password, adminCredential.password);
      if (isPasswordValid) {
        const userData = {
          username: adminCredential.username,
          role: adminCredential.role,
          userEmail: adminCredential.userEmail,
        };
        auditLogger.logAudit({
          action: 'LOGIN',
          resource: 'admin_session',
          resourceId: adminCredential._id,
          userId: adminCredential.userEmail,
          userEmail: adminCredential.userEmail,
          role: adminCredential.role,
          newData: {
            loginTime: new Date(),
            username: userData.username,
          },
          metadata: {
            adminAction: true,
            loginSuccess: true,
          },
          ...userInfo,
        });
        return res.status(200).json({
          success: true,
          message: 'Login successful',
          ...userData,
        });
      } else {
        auditLogger.logAudit({
          action: 'LOGIN_FAILED',
          resource: 'admin_session',
          resourceId: adminCredential._id,
          userId: username,
          userEmail: username,
          role: adminCredential.role,
          newData: {
            attemptTime: new Date(),
            username: username,
          },
          metadata: {
            adminAction: false,
            loginSuccess: false,
            failureReason: 'invalid_password',
          },
          ...userInfo,
        });
        return res.status(401).json({
          success: false,
          message: 'Invalid credentials',
        });
      }
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  });
  router.post('/seed-user', async (req, res) => {
    const defaultEmail = 'contact@toolmate.com.au';
    const defaultName = 'Allan Davis';
    const existingAdmin = await adminCredentialsStorage.findOne({ userEmail: defaultEmail });
    if (existingAdmin) {
      console.log("Admin credential with email 'tanjidshafin1234@gmail.com' already exists. Skipping seeding.");
      return;
    }
    const defaultPassword = '123456';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);
    const credentialDocument = {
      username: defaultName,
      role: 'owner',
      userEmail: defaultEmail,
      password: hashedPassword,
    };
    await adminCredentialsStorage.insertOne(credentialDocument);
  });

  // Admin Change Credentials
  router.post('/api/v1/admin/change-credentials', async (req, res) => {
    try {
      const { userEmail, currentPassword, newUsername, newPassword } = req.body;
      const userInfo = getUserInfoFromRequest(req);
      if (!userEmail || !currentPassword || (!newUsername && !newPassword)) {
        return res.status(400).json({
          success: false,
          message: 'User email, current password, and at least one of new username or new password are required.',
        });
      }
      const adminCredential = await adminCredentialsStorage.findOne({ userEmail: userEmail });
      if (!adminCredential) {
        auditLogger.logAudit({
          action: 'CHANGE_CREDENTIALS_FAILED',
          resource: 'admin_credential',
          resourceId: null,
          userId: userEmail,
          userEmail: userEmail,
          role: 'unknown',
          newData: {
            attemptTime: new Date(),
            reason: 'User not found for credential change',
          },
          metadata: {
            adminAction: true,
            changeSuccess: false,
          },
          ...userInfo,
        });
        return res.status(404).json({
          success: false,
          message: 'Admin user not found.',
        });
      }
      const isPasswordValid = await bcrypt.compare(currentPassword, adminCredential.password);
      if (!isPasswordValid) {
        auditLogger.logAudit({
          action: 'CHANGE_CREDENTIALS_FAILED',
          resource: 'admin_credential',
          resourceId: adminCredential._id,
          userId: userEmail,
          userEmail: userEmail,
          role: adminCredential.role,
          newData: {
            attemptTime: new Date(),
            reason: 'Invalid current password',
          },
          metadata: {
            adminAction: true,
            changeSuccess: false,
          },
          ...userInfo,
        });
        return res.status(401).json({
          success: false,
          message: 'Invalid current password.',
        });
      }
      const updateFields = {};
      if (newUsername) {
        updateFields.username = newUsername;
      }
      if (newPassword) {
        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        updateFields.password = hashedNewPassword;
      }
      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No new username or password provided for update.',
        });
      }
      const result = await adminCredentialsStorage.updateOne({ _id: adminCredential._id }, { $set: updateFields });
      if (result.modifiedCount === 1) {
        auditLogger.logAudit({
          action: 'CHANGE_CREDENTIALS',
          resource: 'admin_credential',
          resourceId: adminCredential._id,
          userId: userEmail,
          userEmail: userEmail,
          role: adminCredential.role,
          newData: {
            updatedFields: Object.keys(updateFields),
            oldUsername: adminCredential.username,
            newUsername: newUsername || adminCredential.username,
            passwordChanged: !!newPassword,
          },
          metadata: {
            adminAction: true,
            changeSuccess: true,
          },
          ...userInfo,
        });
        await emailTriggers.triggerSystemAlert(
          userEmail,
          newUsername,
          `Password Updated`,
          `G’day ${newUsername.split(' ')[0]},

Just letting you know, your ToolMate account password’s been updated and you’re all set. Here’s what you’ll need to log in:
Email: ${userEmail}  
New Password: ${newPassword}
A couple of quick tips, mate:
1. Jump in and log on with your new password when you get a sec.
2. Keep this email private — don’t go sharing your password with anyone.
3. If you didn’t ask for this change, give us a shout at contact@toolmate.com.au and we’ll sort it out.

Got any dramas or need a hand with anything?
Just reply to this email or reach out to our support crew.

Catch you soon,  
Matey from ToolMate`
        );
        return res.status(200).json({
          success: true,
          message: 'Credentials updated successfully.',
        });
      } else {
        auditLogger.logAudit({
          action: 'CHANGE_CREDENTIALS_FAILED',
          resource: 'admin_credential',
          resourceId: adminCredential._id,
          userId: userEmail,
          userEmail: userEmail,
          role: adminCredential.role,
          newData: {
            attemptTime: new Date(),
            reason: 'No changes applied or document not found for update',
          },
          metadata: {
            adminAction: true,
            changeSuccess: false,
          },
          ...userInfo,
        });
        return res.status(500).json({
          success: false,
          message: 'Failed to update credentials.',
        });
      }
    } catch (error) {
      console.error('Change credentials error:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  });

  return router;
};
