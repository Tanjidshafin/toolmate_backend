const sgMail = require("@sendgrid/mail")
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@toolmate.com"
const FROM_NAME = process.env.FROM_NAME || "Toolmate"
class EmailService {
  constructor(emailLogsStorage) {
    this.emailLogsStorage = emailLogsStorage
    if (!SENDGRID_API_KEY) {
      console.error("❌ SendGrid configuration missing! Check environment variables:")
      console.error("- SENDGRID_API_KEY:", !!SENDGRID_API_KEY)
      console.error("- FROM_EMAIL:", FROM_EMAIL)
    } else {
      sgMail.setApiKey(SENDGRID_API_KEY)
    }
  }
  async logEmail(emailData) {
    try {
      const logEntry = {
        ...emailData,
        timestamp: new Date(),
      }
      await this.emailLogsStorage.insertOne(logEntry)
    } catch (error) {
      console.error("❌ Failed to log email:", error)
    }
  }
  async sendWelcomeEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: FROM_NAME,
        },
        subject: "Welcome to Toolmate!",
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
      }
      console.log("📤 Sending email with SendGrid to:", userEmail)
      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "welcome",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      })
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send welcome email:", error)
      await this.logEmail({
        type: "welcome",
        recipient: userEmail,
        recipientName: userName,
        subject: "Welcome to Toolmate!",
        error: error.message,
        errorCode: error.code,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }
  async sendPasswordResetSuccessEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`,
        },
        subject: "Password Reset Successful",
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
      }
      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "password_reset_success",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      })
      console.log("✅ Password reset email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send password reset email:", error)
      await this.logEmail({
        type: "password_reset_success",
        recipient: userEmail,
        recipientName: userName,
        subject: "Password Reset Successful",
        error: error.message,
        errorCode: error.code,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }
  async sendAccountBannedEmail(userEmail, userName) {
    const message = `Hi ${userName},\n\nYour account has been temporarily suspended due to a violation of our terms of service.\n\nIf you believe this is an error, please contact support at help@toolmate.com with your account details.\n\nBest regards,\nThe Toolmate Team`
    return await this.sendSystemAlertEmail(userEmail, userName, "account_banned", message)
  }
  async sendAccountUnbannedEmail(userEmail, userName) {
    const message = `Hi ${userName},\n\nGood news! Your account has been reactivated and you can now access all Toolmate features.\n\nThank you for your patience.\n\nBest regards,\nThe Toolmate Team`
    return await this.sendSystemAlertEmail(userEmail, userName, "account_unbanned", message)
  }

  async sendSystemAlertEmail(userEmail, userName, alertType, message) {
    console.log("📧 Sending system alert email:", alertType, "to:", userEmail)
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }
      const subjectMap = {
        account_banned: "Account Suspended",
        account_unbanned: "Account Reactivated",
        security_alert: "Security Alert",
        system_maintenance: "System Maintenance Notice",
      }
      const subject = subjectMap[alertType] || `Account Update: ${alertType.replace("_", " ")}`
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `Heads up from ${FROM_NAME}`,
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
                        ${message.replace(/\n/g, "<br>")}
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
      }
      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "system_alert",
        subType: alertType,
        recipient: userEmail,
        recipientName: userName,
        subject: subject,
        message: message,
        sendgridResponse: response[0],
        success: true,
      })
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send system alert email:", error)

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
      })
      return { success: false, error: error.message }
    }
  }

  async sendNameChangedEmail(userEmail, userName, oldName, newName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`,
        },
        subject: "Profile Name Updated Successfully",
        text: `Hi ${userName},\n\nYour profile name has been successfully updated.\n\nOld Name: ${oldName}\nNew Name: ${newName}\n\nIf you didn't make this change, please contact support immediately at help@toolmate.com.\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
            <div style="background: #4CAF50; padding: 30px; text-align: center; position: relative;">
              <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                <span style="font-size: 32px;">👤</span>
              </div>
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Profile Name Updated</h1>
            </div>
            
            <div style="padding: 40px 30px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0;">Hi ${userName}! ✨</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your profile name has been successfully updated in your Toolmate account.</p>
              
              <div style="background: #E8F5E8; border-left: 4px solid #4CAF50; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #2E7D32; margin: 0 0 10px 0; font-size: 16px;">Name Change Details:</h3>
                <p style="color: #424242; margin: 5px 0; font-size: 14px;"><strong>Previous Name:</strong> ${oldName}</p>
                <p style="color: #424242; margin: 5px 0; font-size: 14px;"><strong>New Name:</strong> ${newName}</p>
              </div>
              
              <div style="background: #FFF3CD; border-left: 4px solid #FF9800; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <p style="color: #424242; margin: 0; font-size: 14px;">If you didn't make this change, please contact our support team immediately at <a href="mailto:help@toolmate.com" style="color: #F57F17;">help@toolmate.com</a></p>
              </div>
            </div>
            
            <div style="background: #424242; padding: 25px; text-align: center; color: white;">
              <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "name_changed",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { oldName, newName },
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ Name changed email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send name changed email:", error)
      await this.logEmail({
        type: "name_changed",
        recipient: userEmail,
        recipientName: userName,
        subject: "Profile Name Updated Successfully",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }

  async sendEmailChangedEmail(userEmail, userName, oldEmail, newEmail) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const msg = {
        to: newEmail, // Send to new email address
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`,
        },
        subject: "Email Address Updated Successfully",
        text: `Hi ${userName},\n\nYour email address has been successfully updated.\n\nOld Email: ${oldEmail}\nNew Email: ${newEmail}\n\nIf you didn't make this change, please contact support immediately at help@toolmate.com.\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
            <div style="background: #2196F3; padding: 30px; text-align: center; position: relative;">
              <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                <span style="font-size: 32px;">📧</span>
              </div>
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Email Address Updated</h1>
            </div>
            
            <div style="padding: 40px 30px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0;">Hi ${userName}! 📬</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your email address has been successfully updated in your Toolmate account.</p>
              
              <div style="background: #E3F2FD; border-left: 4px solid #2196F3; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #1565C0; margin: 0 0 10px 0; font-size: 16px;">Email Change Details:</h3>
                <p style="color: #424242; margin: 5px 0; font-size: 14px;"><strong>Previous Email:</strong> ${oldEmail}</p>
                <p style="color: #424242; margin: 5px 0; font-size: 14px;"><strong>New Email:</strong> ${newEmail}</p>
              </div>
              
              <div style="background: #FFF3CD; border-left: 4px solid #FF9800; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <p style="color: #424242; margin: 0; font-size: 14px;">If you didn't make this change, please contact our support team immediately at <a href="mailto:help@toolmate.com" style="color: #F57F17;">help@toolmate.com</a></p>
              </div>
            </div>
            
            <div style="background: #424242; padding: 25px; text-align: center; color: white;">
              <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "email_changed",
        recipient: newEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { oldEmail, newEmail },
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ Email changed notification sent to:", newEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send email changed notification:", error)
      await this.logEmail({
        type: "email_changed",
        recipient: newEmail,
        recipientName: userName,
        subject: "Email Address Updated Successfully",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }

  async sendPasswordChangedEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`,
        },
        subject: "Password Changed Successfully",
        text: `Hi ${userName},\n\nYour password has been successfully changed.\n\nIf you didn't make this change, please contact support immediately at help@toolmate.com and secure your account.\n\nBest regards,\nThe Toolmate Security Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
            <div style="background: #FF5722; padding: 30px; text-align: center; position: relative;">
              <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                <span style="font-size: 32px;">🔒</span>
              </div>
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Password Changed</h1>
            </div>
            
            <div style="padding: 40px 30px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0;">Hi ${userName}! 🔐</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your password has been successfully changed for your Toolmate account.</p>
              
              <div style="background: #FFEBEE; border-left: 4px solid #FF5722; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #D32F2F; margin: 0 0 10px 0; font-size: 16px;">🛡️ Security Update</h3>
                <p style="color: #424242; margin: 0; font-size: 14px;">Your account password was changed on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}</p>
              </div>
              
              <div style="background: #FFF3CD; border-left: 4px solid #FF9800; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h4 style="color: #F57F17; margin: 0 0 10px 0; font-size: 16px;">⚠️ Important Security Notice</h4>
                <p style="color: #424242; margin: 0; font-size: 14px;">If you didn't make this change, your account may be compromised. Please contact our support team immediately at <a href="mailto:help@toolmate.com" style="color: #F57F17;">help@toolmate.com</a></p>
              </div>
            </div>
            
            <div style="background: #424242; padding: 25px; text-align: center; color: white;">
              <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Security Team</p>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "password_changed",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ Password changed email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send password changed email:", error)
      await this.logEmail({
        type: "password_changed",
        recipient: userEmail,
        recipientName: userName,
        subject: "Password Changed Successfully",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }

  async sendUserBannedEmail(userEmail, userName, reason = null) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const reasonText = reason ? `\n\nReason: ${reason}` : ""

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Moderation`,
        },
        subject: "Account Suspended - Action Required",
        text: `Hi ${userName},\n\nYour Toolmate account has been suspended due to a violation of our terms of service.${reasonText}\n\nIf you believe this is an error, please contact our support team at help@toolmate.com with your account details.\n\nBest regards,\nThe Toolmate Moderation Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
            <div style="background: #F44336; padding: 30px; text-align: center; position: relative;">
              <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                <span style="font-size: 32px;">🚫</span>
              </div>
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Account Suspended</h1>
            </div>
            
            <div style="padding: 40px 30px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0;">Hi ${userName},</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your Toolmate account has been temporarily suspended due to a violation of our terms of service.</p>
              
              ${
                reason
                  ? `
              <div style="background: #FFEBEE; border-left: 4px solid #F44336; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #C62828; margin: 0 0 10px 0; font-size: 16px;">Reason for Suspension:</h3>
                <p style="color: #424242; margin: 0; font-size: 14px;">${reason}</p>
              </div>
              `
                  : ""
              }
              
              <div style="background: #E8F5E8; border-left: 4px solid #4CAF50; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #2E7D32; margin: 0 0 10px 0; font-size: 16px;">📞 Appeal Process</h3>
                <p style="color: #424242; margin: 0; font-size: 14px;">If you believe this suspension is an error, please contact our support team at <a href="mailto:help@toolmate.com" style="color: #F57F17;">help@toolmate.com</a> with your account details.</p>
              </div>
            </div>
            
            <div style="background: #424242; padding: 25px; text-align: center; color: white;">
              <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Moderation Team</p>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "user_banned",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { reason },
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ User banned email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send user banned email:", error)
      await this.logEmail({
        type: "user_banned",
        recipient: userEmail,
        recipientName: userName,
        subject: "Account Suspended - Action Required",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }

  async sendUserUnbannedEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Support`,
        },
        subject: "Welcome Back! Account Reactivated",
        text: `Hi ${userName},\n\nGreat news! Your Toolmate account has been reactivated and you now have full access to all features.\n\nThank you for your patience during the review process.\n\nWelcome back!\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
            <div style="background: #4CAF50; padding: 30px; text-align: center; position: relative;">
              <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                <span style="font-size: 32px;">🎉</span>
              </div>
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Welcome Back!</h1>
            </div>
            
            <div style="padding: 40px 30px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0;">Hi ${userName}! 🎊</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Great news! Your Toolmate account has been reactivated and you now have full access to all features.</p>
              
              <div style="background: #E8F5E8; border-left: 4px solid #4CAF50; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #2E7D32; margin: 0 0 10px 0; font-size: 16px;">✅ Account Status: Active</h3>
                <p style="color: #424242; margin: 0; font-size: 14px;">You can now access all Toolmate features and services without any restrictions.</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://toolmate.com/dashboard" style="display: inline-block; background: #4CAF50; color: white; padding: 15px 30px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px;">
                  🚀 Continue to Dashboard
                </a>
              </div>
              
              <div style="background: #FFF9C4; border-left: 4px solid #FFC107; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <p style="color: #424242; margin: 0; font-size: 14px;">Thank you for your patience during the review process. We're excited to have you back!</p>
              </div>
            </div>
            
            <div style="background: #424242; padding: 25px; text-align: center; color: white;">
              <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "user_unbanned",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ User unbanned email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send user unbanned email:", error)
      await this.logEmail({
        type: "user_unbanned",
        recipient: userEmail,
        recipientName: userName,
        subject: "Welcome Back! Account Reactivated",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }

  async sendRoleChangedEmail(userEmail, userName, oldRole, newRole) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Admin`,
        },
        subject: "Account Role Updated",
        text: `Hi ${userName},\n\nYour account role has been updated in Toolmate.\n\nPrevious Role: ${oldRole}\nNew Role: ${newRole}\n\nThis change may affect your access permissions. If you have any questions, please contact support at help@toolmate.com.\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: white;">
            <div style="background: #9C27B0; padding: 30px; text-align: center; position: relative;">
              <div style="background: white; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
                <span style="font-size: 32px;">👑</span>
              </div>
              <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 700;">Role Updated</h1>
            </div>
            
            <div style="padding: 40px 30px; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #424242; font-size: 22px; margin: 0 0 15px 0;">Hi ${userName}! 🎭</h2>
              <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your account role has been updated in Toolmate. This change may affect your access permissions.</p>
              
              <div style="background: #F3E5F5; border-left: 4px solid #9C27B0; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #7B1FA2; margin: 0 0 10px 0; font-size: 16px;">Role Change Details:</h3>
                <p style="color: #424242; margin: 5px 0; font-size: 14px;"><strong>Previous Role:</strong> ${oldRole}</p>
                <p style="color: #424242; margin: 5px 0; font-size: 14px;"><strong>New Role:</strong> ${newRole}</p>
              </div>
              
              <div style="background: #E3F2FD; border-left: 4px solid #2196F3; padding: 20px; margin: 25px 0; border-radius: 0 8px 8px 0;">
                <h3 style="color: #1565C0; margin: 0 0 10px 0; font-size: 16px;">ℹ️ What This Means</h3>
                <p style="color: #424242; margin: 0; font-size: 14px;">Your new role may grant you additional permissions or modify your current access level. If you have questions about your new permissions, please contact support.</p>
              </div>
              
              <div style="text-align: center; margin: 30px 0;">
                <a href="https://toolmate.com/dashboard" style="display: inline-block; background: #9C27B0; color: white; padding: 15px 30px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px;">
                  🚀 Explore Your Dashboard
                </a>
              </div>
            </div>
            
            <div style="background: #424242; padding: 25px; text-align: center; color: white;">
              <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "role_changed",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { oldRole, newRole },
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ Role changed email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send role changed email:", error)
      await this.logEmail({
        type: "role_changed",
        recipient: userEmail,
        recipientName: userName,
        subject: "Account Role Updated",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }

  async sendSubscriptionGiftedEmail(userEmail, userName, giftedBy = "Toolmate") {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error("SendGrid API key missing")
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: FROM_NAME,
        },
        subject: "🎁 Surprise! Premium Subscription Gifted to You",
        text: `Hi ${userName},\n\nAmazing news! You've been gifted a premium subscription by ${giftedBy}!\n\nYour premium features are now active and you can enjoy:\n- Unlimited AI tool recommendations\n- Priority support\n- Advanced analytics\n- Exclusive beta features\n\nStart exploring your premium benefits today!\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: full; margin: 0 auto; background: linear-gradient(135deg, #FFD700 0%, #FFA000 100%);">
            <div style="background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
              <div style="position: absolute; top: 20px; left: 20px; width: 40px; height: 40px; background: rgba(255,255,255,0.2); border-radius: 50%; animation: float 3s ease-in-out infinite;"></div>
              <div style="position: absolute; top: 60px; right: 30px; width: 25px; height: 25px; background: rgba(255,255,255,0.3); transform: rotate(45deg);"></div>
              <div style="position: absolute; bottom: 30px; left: 60px; width: 30px; height: 30px; background: rgba(255,255,255,0.2); border-radius: 50%;"></div>
              
              <div style="position: relative; z-index: 2;">
                <div style="background: white; width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 25px; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(0,0,0,0.2); animation: bounce 2s ease-in-out infinite;">
                  <span style="font-size: 48px;">🎁</span>
                </div>
                <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 800; text-shadow: 0 2px 4px rgba(0,0,0,0.3);">Premium Gifted!</h1>
                <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 18px; font-weight: 500;">You've received an amazing gift!</p>
              </div>
            </div>
            
            <div style="padding: 50px 30px; background: white;">
              <div style="text-align: center; margin-bottom: 40px;">
                <h2 style="color: #FF6B35; font-size: 28px; margin: 0 0 15px 0; font-weight: 800;">Hi ${userName}! 🌟</h2>
                <p style="color: #424242; font-size: 18px; line-height: 1.6; margin: 0;">Amazing news! You've been gifted a premium subscription by <strong style="color: #FF6B35;">${giftedBy}</strong>!</p>
              </div>
              
              <!-- Gift details -->
              <div style="background: linear-gradient(135deg, #FFF8E1 0%, #FFECB3 100%); border: 2px solid #FFB300; padding: 30px; border-radius: 20px; margin: 40px 0; text-align: center; position: relative;">
                <div style="position: absolute; top: -15px; left: 50%; transform: translateX(-50%); background: #FFB300; color: white; padding: 8px 20px; border-radius: 20px; font-weight: 600; font-size: 14px;">🎉 PREMIUM ACTIVATED</div>
                <h3 style="color: #FF8F00; margin: 20px 0 20px 0; font-size: 22px; font-weight: 700;">Your Premium Benefits:</h3>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-top: 25px;">
                  <div style="text-align: center;">
                    <div style="background: #FF6B35; width: 50px; height: 50px; border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center;">
                      <span style="color: white; font-size: 20px;">🚀</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 600;">Unlimited AI Recommendations</p>
                  </div>
                  <div style="text-align: center;">
                    <div style="background: #FF6B35; width: 50px; height: 50px; border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center;">
                      <span style="color: white; font-size: 20px;">⚡</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 600;">Priority Support</p>
                  </div>
                  <div style="text-align: center;">
                    <div style="background: #FF6B35; width: 50px; height: 50px; border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center;">
                      <span style="color: white; font-size: 20px;">📊</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 600;">Advanced Analytics</p>
                  </div>
                  <div style="text-align: center;">
                    <div style="background: #FF6B35; width: 50px; height: 50px; border-radius: 50%; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center;">
                      <span style="color: white; font-size: 20px;">🔬</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 600;">Exclusive Beta Features</p>
                  </div>
                </div>
              </div>
              
              <!-- CTA Button -->
              <div style="text-align: center; margin: 50px 0;">
                <a href="https://toolmate.com/dashboard" style="display: inline-block; background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); color: white; padding: 20px 40px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 18px; box-shadow: 0 8px 25px rgba(255, 107, 53, 0.4); text-transform: uppercase; letter-spacing: 1px; transition: all 0.3s ease;">
                  🎯 Start Using Premium Now
                </a>
              </div>
              
              <!-- Thank you note -->
              <div style="background: #F3E5F5; border-left: 6px solid #9C27B0; padding: 25px; border-radius: 0 15px 15px 0; margin: 40px 0;">
                <h4 style="color: #7B1FA2; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">💜 A Special Thank You</h4>
                <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.6;">This premium subscription is a gift from <strong>${giftedBy}</strong>. Make sure to thank them for this amazing gesture!</p>
              </div>
            </div>
            
            <!-- Footer -->
            <div style="background: #424242; padding: 40px 30px; text-align: center; color: white;">
              <div style="margin-bottom: 20px;">
                <div style="display: inline-block; background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); width: 50px; height: 50px; border-radius: 50%; margin-bottom: 15px;">
                  <span style="color: white; font-size: 24px; font-weight: bold; line-height: 50px;">T</span>
                </div>
              </div>
              <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Enjoy your premium experience!</p>
              <p style="margin: 0; color: #FFC107; font-size: 20px; font-weight: 700;">The Toolmate Team</p>
              <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid #616161;">
                <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. Crafted with ❤️ for premium users</p>
              </div>
            </div>
          </div>
        `,
      }

      const response = await sgMail.send(msg)
      await this.logEmail({
        type: "subscription_gifted",
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { giftedBy },
        sendgridResponse: response[0],
        success: true,
      })

      console.log("✅ Subscription gifted email sent to:", userEmail)
      return { success: true, response: response[0] }
    } catch (error) {
      console.error("❌ Failed to send subscription gifted email:", error)
      await this.logEmail({
        type: "subscription_gifted",
        recipient: userEmail,
        recipientName: userName,
        subject: "🎁 Surprise! Premium Subscription Gifted to You",
        error: error.message,
        success: false,
      })
      return { success: false, error: error.message }
    }
  }
}

module.exports = EmailService
