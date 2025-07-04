const sgMail = require('@sendgrid/mail');
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@toolmate.com';
const FROM_NAME = process.env.FROM_NAME || 'Toolmate';
class EmailService {
  constructor(emailLogsStorage) {
    this.emailLogsStorage = emailLogsStorage;
    if (!SENDGRID_API_KEY) {
      console.error('❌ SendGrid configuration missing! Check environment variables:');
      console.error('- SENDGRID_API_KEY:', !!SENDGRID_API_KEY);
      console.error('- FROM_EMAIL:', FROM_EMAIL);
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
      console.error('❌ Failed to log email:', error);
    }
  }
  async sendWelcomeEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key missing');
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: FROM_NAME,
        },
        subject: 'Welcome to Toolmate!',
        text: `Hi ${userName},\n\nWelcome to Toolmate! We're excited to have you on board.\n\nGet started by exploring our AI-powered tool recommendations and building your personal tool shed.\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: linear-gradient(135deg, #FFF9C4 0%, #FFEB3B 100%); border-radius: 0;">
                  <!-- Header with pattern -->
                  <div style="background: #F57F17; padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
                    <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%; transform: rotate(45deg);"></div>
                    <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
                    <div style="position: relative; z-index: 2;">
                      <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                        <span style="font-size: 36px;">🚀</span>
                      </div>
                      <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Welcome to Toolmate!</h1>
                    </div>
                  </div>
                  
                  <!-- Main content -->
                  <div style="padding: 40px 0px; background: white;">
                    <div style="text-align: center; margin-bottom: 30px;">
                      <h2 style="color: #F57F17; font-size: 24px; margin: 0 0 15px 0; font-weight: 800;">Hi ${userName}! 👋</h2>
                      <p style="color: #424242; font-size: 18px; line-height: 1.6; margin: 0;">We're absolutely thrilled to have you join our community of tool enthusiasts!</p>
                    </div>
                    
                    <!-- Feature highlights -->
                    <div style="background: #FFFDE7; border-left: 4px solid #FFC107; padding: 25px; max-width:800px; margin: 30px auto; border-radius: 0 8px 8px 0;">
                      <h3 style="color: #F57F17; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">🎯 What's waiting for you:</h3>
                      <ul style="color: #424242; margin: 0; padding-left: 20px; line-height: 1.8;">
                        <li>AI-powered tool recommendations tailored just for you</li>
                        <li>Build and organize your personal tool shed</li>
                        <li>Discover hidden gems from our curated collection</li>
                        <li>Connect with fellow tool enthusiasts</li>
                      </ul>
                    </div>
                    
                    <!-- CTA Button -->
                    <div style="text-align: center; margin: 40px 0;">
                      <a href="https://toolmate.com" style="display: inline-block; background: #F57F17; color: white; padding: 18px 40px; text-decoration: none; border-radius: 50px; font-weight: 600; font-size: 16px; box-shadow: 0 6px 20px rgba(245, 127, 23, 0.3); transition: all 0.3s ease; text-transform: uppercase; letter-spacing: 1px;">
                        🚀 Start Exploring Now
                      </a>
                    </div>
                    
                    <!-- Social proof -->
                    <div style="background: #FFF8E1;  padding: 20px; max-width:800px; border-radius: 12px;  text-align: center; margin: 30px auto;">
                      <p style="color: #F57F17; margin: 0; font-weight: 600; font-size: 14px;">⭐ Join 50,000+ users who've already discovered their perfect tools!</p>
                    </div>
                  </div>
                  
                  <!-- Footer -->
                  <div style="background: #424242; padding: 30px; text-align: center; color: white;">
                    <p style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
                    <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
                    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
                      <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. All rights reserved.</p>
                    </div>
                  </div>
                </div>
        `,
      };
      console.log('📤 Sending email with SendGrid to:', userEmail);
      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'welcome',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      });
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send welcome email:', error);
      await this.logEmail({
        type: 'welcome',
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
        throw new Error('SendGrid API key missing');
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`,
        },
        subject: 'Password Reset Successful',
        text: `Hi ${userName},\n\nYour password has been successfully reset.\n\nIf you didn't make this change, please contact support immediately at help@toolmate.com.\n\nBest regards,\nThe Toolmate Security Team`,
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
                  <!-- Header -->
                  <div style="background: #FFC107; padding: 30px; text-align: center; position: relative;">
                    <div style="background: white; width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                      <span style="font-size: 40px;">🔐</span>
                    </div>
                    <h1 style="color: #424242; margin: 0; font-size: 28px; font-weight: 700;">Password Reset Successful</h1>
                    <div style="width: 60px; height: 4px; background: #F57F17; margin: 15px auto 0; border-radius: 2px;"></div>
                  </div>
                  
                  <!-- Main content -->
                  <div style="padding: 40px 0px; max-width:850px; margin:0 auto">
                    <div style="text-align: center; margin-bottom: 30px;">
                      <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0; font-weight: 800;">Hi ${userName}! ✅</h2>
                      <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0;">Your password has been successfully updated and your account is now secure.</p>
                    </div>
                    
                    <!-- Success indicator -->
                    <div style="background: #FFF9C4; border: 2px solid #FFC107; padding: 25px; border-radius: 12px; margin: 30px auto; text-align: center;">
                      <div style="background: #4CAF50; width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center;">
                        <span style="color: white; font-size: 24px; font-weight: bold;">✓</span>
                      </div>
                      <h3 style="color: #F57F17; margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Password Updated Successfully!</h3>
                      <p style="color: #424242; margin: 0; font-size: 14px;">Your account security has been enhanced.</p>
                    </div>
                    
                    <!-- Security warning -->
                    <div style="background: #FFF3CD; border-left: 6px solid #FF9800; padding: 25px; margin: 30px 0; border-radius: 0 8px 8px 0;">
                      <div style="display: flex; align-items: flex-start; gap: 15px;">
                        <div style="background: #FF9800; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                          <span style="color: white; font-size: 18px; font-weight: bold;">⚠️</span>
                        </div>
                        <div>
                          <h4 style="color: #F57F17; margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Security Notice</h4>
                          <p style="color: #424242; margin: 0; line-height: 1.5; font-size: 14px;">If you didn't make this change, please contact our support team immediately at <a href="mailto:help@toolmate.com" style="color: #F57F17; text-decoration: none; font-weight: 600;">help@toolmate.com</a></p>
                        </div>
                      </div>
                    </div>
                    
                    <!-- Support section -->
                    <div style="background: #FFFDE7; padding: 25px; border-radius: 12px; text-align: center; margin: 30px 0;">
                      <h4 style="color: #F57F17; margin: 0 0 15px 0; font-size: 16px; font-weight: 600;">Need Help?</h4>
                      <p style="color: #424242; margin: 0 0 15px 0; font-size: 14px;">Our security team is here to assist you 24/7</p>
                      <a href="mailto:help@toolmate.com" style="display: inline-block; background: #F57F17; color: white; padding: 12px 25px; text-decoration: none; border-radius: 25px; font-weight: 600; font-size: 14px;">Contact Support</a>
                    </div>
                  </div>
                  
                  <!-- Footer -->
                  <div style="background: #424242; padding: 25px; text-align: center; color: white;">
                    <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
                    <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Security Team</p>
                  </div>
                </div>
        `,
      };
      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'password_reset_success',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      });
      console.log('✅ Password reset email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send password reset email:', error);
      await this.logEmail({
        type: 'password_reset_success',
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
    return await this.sendSystemAlertEmail(userEmail, userName, 'account_banned', message);
  }
  async sendAccountUnbannedEmail(userEmail, userName) {
    const message = `Hi ${userName},\n\nGood news! Your account has been reactivated and you can now access all Toolmate features.\n\nThank you for your patience.\n\nBest regards,\nThe Toolmate Team`;
    return await this.sendSystemAlertEmail(userEmail, userName, 'account_unbanned', message);
  }

  async sendSystemAlertEmail(userEmail, userName, alertType, message) {
    console.log('📧 Sending system alert email:', alertType, 'to:', userEmail);
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key missing');
      }
      const subjectMap = {
        account_banned: 'Account Suspended',
        account_unbanned: 'Account Reactivated',
        security_alert: 'Security Alert',
        system_maintenance: 'System Maintenance Notice',
      };
      const subject = subjectMap[alertType] || `Account Update: ${alertType.replace('_', ' ')}`;
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} System`,
        },
        subject: subject,
        text: message,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
                  <div style="background: #FFEB3B; padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
                    <!-- Geometric shapes -->
                    <div style="position: absolute; top: 20px; left: 30px; width: 30px; height: 30px; background: rgba(245, 127, 23, 0.3); transform: rotate(45deg);"></div>
                    <div style="position: absolute; top: 60px; right: 40px; width: 20px; height: 20px; background: rgba(245, 127, 23, 0.4); border-radius: 50%;"></div>
                    <div style="position: absolute; bottom: 30px; left: 50px; width: 25px; height: 25px; background: rgba(245, 127, 23, 0.2); transform: rotate(30deg);"></div>
                    
                    <div style="position: relative; z-index: 2;">
                      <div style="background: white; width: 80px; height: 80px; border-radius: 16px; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15); transform: rotate(-5deg);">
                        <span style="font-size: 32px;">📧</span>
                      </div>
                      <h1 style="color: #424242; margin: 0; font-size: 28px; font-weight: 700;">${subject}</h1>
                      <div style="width: 80px; height: 4px; background: #F57F17; margin: 15px auto 0; border-radius: 2px;"></div>
                    </div>
                  </div>
                  
                  <div style="">
                  <!-- Main content -->
                  <div style="padding: 40px 0px; max-width:850px; margin:0 auto;">
                    <!-- Message content with enhanced styling -->
                    <div style="background: #FFFDE7; border-radius: 16px;  padding: 30px; margin: 20px 0; position: relative; box-shadow: 0 4px 15px rgba(255, 193, 7, 0.1);">
                      <div style="position: absolute; top: -10px; left: 30px; width: 20px; height: 20px; background: #FFC107; transform: rotate(45deg);"></div>
                      <div style="color: #424242; font-size: 16px; line-height: 1.8; white-space: pre-line;">
                        ${message.replace(/\n/g, '<br>')}
                      </div>
                    </div>
                    
                    <!-- Action section -->
                    <div style="text-align: center; margin: 40px 0;">
                      <div style="background: #FFF9C4; padding: 25px; border-radius: 12px; margin-bottom: 25px;">
                        <h3 style="color: #F57F17; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">📱 Take Action</h3>
                        <p style="color: #424242; margin: 0 0 20px 0; font-size: 14px;">Ready to explore these recommendations?</p>
                        <a href="https://toolmate.com/dashboard" style="display: inline-block; background: #F57F17; color: white; padding: 15px 30px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 14px; box-shadow: 0 4px 15px rgba(245, 127, 23, 0.3);">
                          View Dashboard →
                        </a>
                      </div>
                    </div>
                    
                    <!-- Divider with style -->
                    <div style="text-align: center; margin: 40px 0;">
                      <div style="display: inline-block; position: relative;">
                        <div style="width: 100px; height: 2px; background: #FFC107;"></div>
                        <div style="position: absolute; top: -4px; left: 50%; transform: translateX(-50%); width: 10px; height: 10px; background: #F57F17; border-radius: 50%;"></div>
                      </div>
                    </div>
                    
                    <!-- Footer notice -->
                    <div style="background: #F5F5F5; padding: 20px; border-radius: 8px; text-align: center; border-left: 4px solid #FFC107;">
                      <p style="color: #666; font-size: 13px; margin: 0; line-height: 1.5;">
                        <strong>📬 Automated Message</strong><br>
                        This is an automated message from Toolmate. Please do not reply to this email.<br>
                        For support, visit <a href="https://toolmate.com/support" style="color: #F57F17; text-decoration: none;">our help center</a>
                      </p>
                    </div>
                  </div>
                  </div>
                  
                  <!-- Footer -->
                  <div style="background: #424242; padding: 30px; text-align: center; color: white;">
                    <div style="margin-bottom: 15px;">
                      <div style="display: inline-block; background: #FFC107; width: 40px; height: 40px; border-radius: 50%; margin-bottom: 10px;">
                        <span style="color: #424242; font-size: 20px; font-weight: bold; line-height: 40px;">T</span>
                      </div>
                    </div>
                    <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">Toolmate Team</p>
                    <div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid #616161;">
                      <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. Crafted with ❤️ for tool enthusiasts</p>
                    </div>
                  </div>
                </div>
        `,
      };
      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'system_alert',
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
      console.error('❌ Failed to send system alert email:', error);

      await this.logEmail({
        type: 'system_alert',
        subType: alertType,
        recipient: userEmail,
        recipientName: userName,
        subject: `Account Update: ${alertType.replace('_', ' ')}`,
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
