const sgMail = require('@sendgrid/mail');
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@toolmate.com';
const FROM_NAME = process.env.FROM_NAME || 'Toolmate';
class EmailService {
  constructor(emailLogsStorage) {
    this.emailLogsStorage = emailLogsStorage;
    if (!SENDGRID_API_KEY) {
      console.error("❌ SendGrid configuration missing! Check environment variables:");
      console.error("- SENDGRID_API_KEY:", !!SENDGRID_API_KEY);
      console.error("- FROM_EMAIL:", FROM_EMAIL);
    } else {
      sgMail.setApiKey(SENDGRID_API_KEY);
    }
  }
  async logEmail(emailData) {
    try {
      const logEntry = {
        ...emailData,
        timestamp: new Date(),
      };
      await this.emailLogsStorage.insertOne(logEntry);
    } catch (error) {
      console.error("❌ Failed to log email:", error);
    }
  }
  async sendWelcomeEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing");
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: FROM_NAME
        },
        subject: 'Welcome to Toolmate!',
        text: `Hi ${userName},\n\nWelcome to Toolmate! We're excited to have you on board.\n\nGet started by exploring our AI-powered tool recommendations and building your personal tool shed.\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Welcome to Toolmate!</h2>
            <p>Hi ${userName},</p>
            <p>Welcome to Toolmate! We're excited to have you on board.</p>
            <p>Get started by exploring our AI-powered tool recommendations and building your personal tool shed.</p>
            <div style="margin: 30px 0;">
              <a href="https://toolmate.com" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">Get Started</a>
            </div>
            <p>Best regards,<br>The Toolmate Team</p>
          </div>
        `
      };
      console.log("📤 Sending email with SendGrid to:", userEmail);
      const response = await sgMail.send(msg);
      await this.logEmail({
        type: "welcome",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      });
      return { success: true, response: response[0] };
    } catch (error) {
      console.error("❌ Failed to send welcome email:", error);
      await this.logEmail({
        type: "welcome",
        recipient: userEmail,
        recipientName: userName,
        subject: 'Welcome to Toolmate!',
        error: error.message,
        errorCode: error.code,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }
  async sendPasswordResetSuccessEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing");
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`
        },
        subject: 'Password Reset Successful',
        text: `Hi ${userName},\n\nYour password has been successfully reset.\n\nIf you didn't make this change, please contact support immediately at help@toolmate.com.\n\nBest regards,\nThe Toolmate Security Team`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #28a745;">Password Reset Successful</h2>
            <p>Hi ${userName},</p>
            <p>Your password has been successfully reset.</p>
            <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <strong>⚠️ Security Notice:</strong> If you didn't make this change, please contact support immediately.
            </div>
            <p>If you need assistance, contact us at <a href="mailto:help@toolmate.com">help@toolmate.com</a></p>
            <p>Best regards,<br>The Toolmate Security Team</p>
          </div>
        `
      };
      const response = await sgMail.send(msg);
      await this.logEmail({
        type: "password_reset_success",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      });
      console.log("✅ Password reset email sent to:", userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error("❌ Failed to send password reset email:", error);
      await this.logEmail({
        type: "password_reset_success",
        recipient: userEmail,
        recipientName: userName,
        subject: 'Password Reset Successful',
        error: error.message,
        errorCode: error.code,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }
  async sendAccountBannedEmail(userEmail, userName) {
    const message = `Hi ${userName},\n\nYour account has been temporarily suspended due to a violation of our terms of service.\n\nIf you believe this is an error, please contact support at help@toolmate.com with your account details.\n\nBest regards,\nThe Toolmate Team`;
    return await this.sendSystemAlertEmail(
      userEmail,
      userName,
      "account_banned",
      message
    );
  }
  async sendAccountUnbannedEmail(userEmail, userName) {
    const message = `Hi ${userName},\n\nGood news! Your account has been reactivated and you can now access all Toolmate features.\n\nThank you for your patience.\n\nBest regards,\nThe Toolmate Team`;
    return await this.sendSystemAlertEmail(
      userEmail,
      userName,
      "account_unbanned",
      message
    );
  }

  async sendSystemAlertEmail(userEmail, userName, alertType, message) {
    console.log("📧 Sending system alert email:", alertType, "to:", userEmail)
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing");
      }
      const subjectMap = {
        account_banned: 'Account Suspended',
        account_unbanned: 'Account Reactivated',
        security_alert: 'Security Alert',
        system_maintenance: 'System Maintenance Notice'
      };
      const subject = subjectMap[alertType] || `Account Update: ${alertType.replace("_", " ")}`;
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} System`
        },
        subject: subject,
        text: message,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">${subject}</h2>
            <div style="white-space: pre-line; line-height: 1.6;">
              ${message.replace(/\n/g, '<br>')}
            </div>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;">
            <p style="color: #666; font-size: 14px;">
              This is an automated message from Toolmate. Please do not reply to this email.
            </p>
          </div>
        `
      };
      const response = await sgMail.send(msg);
      await this.logEmail({
        type: "system_alert",
        subType: alertType,
        recipient: userEmail,
        recipientName: userName,
        subject: subject,
        message: message,
        sendgridResponse: response[0],
        success: true,
      });
      return { success: true, response: response[0] };
    } catch (error) {
      console.error("❌ Failed to send system alert email:", error);
      await this.logEmail({
        type: "system_alert",
        subType: alertType,
        recipient: userEmail,
        recipientName: userName,
        subject: `Account Update: ${alertType.replace("_", " ")}`,
        message: message,
        error: error.message,
        errorCode: error.code,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }
}
module.exports = EmailService;