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
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: linear-gradient(135deg, #FFF9C4 0%, #FFEB3B 100%); border-radius: 0;">
  <!-- Header with pattern -->
  <div style="background: #F57F17; padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
    <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%; transform: rotate(45deg);"></div>
    <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
    
    <!-- Animated tool icon -->
    <div style="margin: 20px auto 30px; width: 80px; height: 80px; background: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.2); animation: pulse 2s infinite;">
      <svg style="width: 40px; height: 40px; fill: #F57F17;" viewBox="0 0 24 24">
        <path d="M11,5H13V9H19V11H13V15H19V17H13V21H11V17H5V15H11V11H5V9H11V5Z" />
      </svg>
    </div>
    
    <h1 style="color: white; margin: 0; font-size: 42px; font-weight: 800; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Welcome to Toolmate!</h1>
  </div>
  
  <!-- Main content -->
  <div style="padding: 40px 0; background: white;">
    <div style="text-align: center; margin-bottom: 30px;">
      <h2 style="color: #F57F17; font-size: 28px; margin: 0 0 15px 0; font-weight: 800;">Hey ${userName}! 👋</h2>
      <p style="color: #424242; font-size: 18px; line-height: 1.6; margin: 0;">Ready to transform how you work with tools? We're excited to have you join our community of DIY enthusiasts and professionals!</p>
    </div>
    
    <!-- Interactive feature highlights -->
    <div style="background: #FFFDE7; border-left: 4px solid #FFC107; padding: 25px; margin: 30px auto; border-radius: 0 8px 8px 0; position: relative;">
      <div style="position: absolute; top: -15px; right: 20px; background: #F57F17; color: white; padding: 5px 15px; border-radius: 20px; font-size: 14px; font-weight: 600;">POPULAR FEATURES</div>
      <h3 style="color: #F57F17; margin: 10px 0 20px 0; font-size: 20px; font-weight: 600;">🚀 Supercharge Your Projects</h3>
      
      <div style="display: flex; align-items: center; margin-bottom: 15px;">
        <div style="background: #FFC107; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
          <span style="color: white; font-weight: bold;">1</span>
        </div>
        <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.5;"><strong>Unlimited chats, full project help</strong></p>
      </div>
      
      <div style="display: flex; align-items: center; margin-bottom: 15px;">
        <div style="background: #FFC107; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
          <span style="color: white; font-weight: bold;">2</span>
        </div>
        <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.5;"><strong>Snap a photo, skip the guesswork</strong> </p>
      </div>
      
      <div style="display: flex; align-items: center; margin-bottom: 15px;">
        <div style="background: #FFC107; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
          <span style="color: white; font-weight: bold;">3</span>
        </div>
        <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.5;"><strong>Matey tracks your tools, old and new</strong></p>
      </div>
      
      <div style="display: flex; align-items: center; margin-bottom: 15px;">
        <div style="background: #FFC107; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
          <span style="color: white; font-weight: bold;">4</span>
        </div>
        <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.5;"><strong>Advice sharpens after every chat</strong> </p>
      </div>
      
      <div style="display: flex; align-items: center;">
        <div style="background: #FFC107; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
          <span style="color: white; font-weight: bold;">5</span>
        </div>
        <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.5;"><strong>Buy once, not twice and save cash</strong></p>
      </div>
    </div>
    
    <!-- CTA Button -->
    <div style="text-align: center; margin: 40px 0;">
      <a href="https://toolmate-testing.netlify.app/" style="display: inline-block; background: linear-gradient(to right, #F57F17, #FF9800); color: white; padding: 18px 40px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 18px; box-shadow: 0 6px 20px rgba(245, 127, 23, 0.4); transition: all 0.3s ease; text-transform: uppercase; letter-spacing: 1px; position: relative; overflow: hidden;">
        <span style="position: relative; z-index: 2;">Start Your First Project!</span>
        <div style="position: absolute; top: 0; left: -100%; width: 100%; height: 100%; background: linear-gradient(to right, transparent, rgba(255,255,255,0.3), transparent); transition: all 0.6s ease; transform: skewX(-25deg);"></div>
      </a>
      <p style="color: #757575; font-size: 14px; margin-top: 15px;">No setup required - just click and go!</p>
    </div>
    
    <!-- Social proof -->
    <div style="background: #FFF8E1; padding: 25px; border-radius: 12px; text-align: center; margin: 30px auto; position: relative;">
      <div style="display: flex; justify-content: center; margin-bottom: 15px;">
        <span style="color: #FFC107; font-size: 18px;">⭐</span>
        <span style="color: #FFC107; font-size: 18px;">⭐</span>
        <span style="color: #FFC107; font-size: 18px;">⭐</span>
        <span style="color: #FFC107; font-size: 18px;">⭐</span>
        <span style="color: #FFC107; font-size: 18px;">⭐</span>
      </div>
      <p style="color: #F57F17; margin: 0; font-weight: 600; font-size: 16px;">Join 50,000+ tool enthusiasts who are working smarter!</p>
    </div>
    
    <!-- Quick tip section -->
    <div style="background: #E8F5E9; padding: 20px; border-radius: 8px; margin: 30px auto; border-left: 4px solid #4CAF50;">
      <div style="display: flex; align-items: flex-start;">
        <div style="background: #4CAF50; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
          <svg style="width: 14px; height: 14px; fill: white;" viewBox="0 0 24 24">
            <path d="M9,22A1,1 0 0,1 8,21V18H4A2,2 0 0,1 2,16V4C2,2.89 2.9,2 4,2H20A2,2 0 0,1 22,4V16A2,2 0 0,1 20,18H13.9L10.2,21.71C10,21.9 9.75,22 9.5,22V22H9Z" />
          </svg>
        </div>
        <div>
          <h4 style="color: #2E7D32; margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Pro Tip</h4>
          <p style="color: #424242; margin: 0; font-size: 15px; line-height: 1.5;">Start by asking Matey about your current project or take a photo of a tool you'd like to learn more about. The more you chat, the better the recommendations get!</p>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Footer -->
  <div style="background: #424242; padding: 30px; text-align: center; color: white;">
    <p style="margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Ready to build something amazing?</p>
    <p style="margin: 0 0 20px 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
    
    <div style="margin: 25px 0; display: flex; justify-content: center; gap: 15px;">
      <a href="#" style="display: inline-block; width: 36px; height: 36px; background: #616161; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
        <svg style="width: 18px; height: 18px; fill: white;" viewBox="0 0 24 24">
          <path d="M22,12C22,10.6867 21.7413,9.38663 21.2388,8.1731C20.7362,6.95968 19.9996,5.85742 19.0711,4.9289C18.1425,4.00036 17.0403,3.26375 15.8269,2.76117C14.6134,2.25866 13.3133,2 12,2C10.6867,2 9.38663,2.25866 8.1731,2.76117C6.95968,3.26375 5.85742,4.00036 4.9289,4.9289C4.00036,5.85742 3.26375,6.95968 2.76117,8.1731C2.25866,9.38663 2,10.6867 2,12C2,17.5228 6.47715,22 12,22C12,21.7667 12,12 12,12C12,12 22,12 22,12Z" />
        </svg>
      </a>
      <a href="#" style="display: inline-block; width: 36px; height: 36px; background: #616161; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
        <svg style="width: 18px; height: 18px; fill: white;" viewBox="0 0 24 24">
          <path d="M17,2V2H17V6H15C14.31,6 14,6.81 14,7.5V10H14L17,10V14H14V22H10V14H7V10H10V6A4,4 0 0,1 14,2H17Z" />
        </svg>
      </a>
      <a href="#" style="display: inline-block; width: 36px; height: 36px; background: #616161; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
        <svg style="width: 18px; height: 18px; fill: white;" viewBox="0 0 24 24">
          <path d="M22.46,6C21.69,6.35 20.86,6.58 20,6.69C20.88,6.16 21.56,5.32 21.88,4.31C21.05,4.81 20.13,5.16 19.16,5.36C18.37,4.5 17.26,4 16,4C13.65,4 11.73,5.92 11.73,8.29C11.73,8.63 11.77,8.96 11.84,9.27C8.28,9.09 5.11,7.38 3,4.79C2.63,5.42 2.42,6.16 2.42,6.94C2.42,8.43 3.17,9.75 4.33,10.5C3.62,10.5 2.96,10.3 2.38,10C2.38,10 2.38,10 2.38,10.03C2.38,12.11 3.86,13.85 5.82,14.24C5.46,14.34 5.08,14.39 4.69,14.39C4.42,14.39 4.15,14.36 3.89,14.31C4.43,16 6,17.26 7.89,17.29C6.43,18.45 4.58,19.13 2.56,19.13C2.22,19.13 1.88,19.11 1.54,19.07C3.44,20.29 5.7,21 8.12,21C16,21 20.33,14.46 20.33,8.79C20.33,8.6 20.33,8.42 20.32,8.23C21.16,7.63 21.88,6.87 22.46,6Z" />
        </svg>
      </a>
    </div>
    
    <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
      <p style="margin: 0 0 10px 0; font-size: 12px; color: #BDBDBD;">You're receiving this email because you signed up for Toolmate</p>
      <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2025 Toolmate. All rights reserved.</p>
    </div>
  </div>
</div>
        `,
      };
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
           <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #FFC107 0%, #F57F17 100%); padding: 40px 5px; text-align: center; position: relative; overflow: hidden;">
        <!-- Decorative elements -->
        <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        
        <div style="background: white; width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
            <span style="font-size: 40px;">🔐</span>
        </div>
        <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Password Reset Successful</h1>
        <div style="width: 60px; height: 4px; background: white; margin: 15px auto 0; border-radius: 2px;"></div>
    </div>
    
    <!-- Main content -->
    <div style="padding: 40px 30px;">
        <div style="text-align: center; margin-bottom: 30px;">
            <h2 style="color: #424242; font-size: 24px; margin: 0 0 15px 0; font-weight: 700;">Hi ${userName}! ✅</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0;">Your password has been successfully updated and your account is now secure.</p>
        </div>
        
        <!-- Success indicator -->
        <div style="background: #FFF9C4; border: 2px solid #FFC107; padding: 25px; border-radius: 12px; margin: 30px auto; text-align: center; position: relative;">
            <div style="background: #4CAF50; width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center;">
                <span style="color: white; font-size: 24px; font-weight: bold;">✓</span>
            </div>
            <h3 style="color: #F57F17; margin: 0 0 10px 0; font-size: 20px; font-weight: 600;">Password Updated Successfully!</h3>
            <p style="color: #424242; margin: 0; font-size: 16px;">Your account security has been enhanced.</p>
            
            <!-- Animated checkmark -->
            <div style="position: absolute; top: -15px; right: -15px; background: #4CAF50; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 8px rgba(0,0,0,0.2);">
                <span style="color: white; font-size: 16px; font-weight: bold;">✓</span>
            </div>
        </div>
        
        <!-- Security checklist -->
        <div style="background: #E8F5E9; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #2E7D32; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; text-align: center;">🔒 Your Account Security Checklist</h4>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px;">
                <div style="background: #4CAF50; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: white; font-size: 14px; font-weight: bold;">✓</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px; line-height: 1.5;"><strong>Strong password</strong> - Your password has been successfully updated</p>
            </div>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px;">
                <div style="background: #4CAF50; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: white; font-size: 14px; font-weight: bold;">✓</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px; line-height: 1.5;"><strong>Secure connection</strong> - All data is encrypted during transmission</p>
            </div>
            
            <div style="display: flex; align-items: center;">
                <div style="background: #FFC107; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: white; font-size: 14px; font-weight: bold;">!</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px; line-height: 1.5;"><strong>Stay vigilant</strong> - Never share your password with anyone</p>
            </div>
        </div>
        
        <!-- Security warning -->
        <div style="background: #FFF3CD; border-left: 6px solid #FF9800; padding: 25px; margin: 30px 0; border-radius: 0 8px 8px 0;">
            <div style="display: flex; align-items: flex-start; gap: 15px;">
                <div>
                    <h4 style="color: #F57F17; margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Security Notice</h4>
                    <p style="color: #424242; margin: 0; line-height: 1.5; font-size: 14px;">If you didn't make this change, please contact our support team immediately at <a href="mailto:help@toolmate.com" style="color: #F57F17; text-decoration: none; font-weight: 600;">help@toolmate.com</a></p>
                </div>
            </div>
        </div>
        
        <!-- Support section -->
        <div style="background: #FFFDE7; padding: 25px; border-radius: 12px; text-align: center; margin: 30px 0; border: 1px dashed #FFC107;">
            <h4 style="color: #F57F17; margin: 0 0 15px 0; font-size: 18px; font-weight: 600;">Need Help?</h4>
            <p style="color: #424242; margin: 0 0 20px 0; font-size: 14px;">Our security team is here to assist you 24/7</p>
            <a href="mailto:help@toolmate.com" style="display: inline-block; background: linear-gradient(to right, #F57F17, #FF9800); color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; font-weight: 600; font-size: 14px; box-shadow: 0 4px 10px rgba(245, 127, 23, 0.3); transition: all 0.3s ease;">Contact Support</a>
        </div>
        
        <!-- Next steps -->
        <div style="background: #E3F2FD; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; text-align: center;">📋 Recommended Next Steps</h4>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E3F2FD; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #1565C0; font-size: 16px; font-weight: bold;">1</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Update your password in any password manager you use</p>
            </div>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E3F2FD; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #1565C0; font-size: 16px; font-weight: bold;">2</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Review your recent account activity for any suspicious actions</p>
            </div>
            
        </div>
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 30px; text-align: center; color: white;">
        <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
        <p style="margin: 0 0 20px 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Security Team</p>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0 0 10px 0; font-size: 12px; color: #BDBDBD;">You're receiving this email because a password change was requested for your Toolmate account.</p>
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2025 Toolmate. All rights reserved.</p>
        </div>
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
          name: `Heads up from ${FROM_NAME}`,
        },
        subject: subject,
        text: message,
        html: `
          <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #FFEB3B 0%, #FFC107 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden;">
        <!-- Geometric shapes -->
        <div style="position: absolute; top: 20px; left: 30px; width: 30px; height: 30px; background: rgba(245, 127, 23, 0.3); transform: rotate(45deg);"></div>
        <div style="position: absolute; top: 60px; right: 40px; width: 20px; height: 20px; background: rgba(245, 127, 23, 0.4); border-radius: 50%;"></div>
        <div style="position: absolute; bottom: 30px; left: 50px; width: 25px; height: 25px; background: rgba(245, 127, 23, 0.2); transform: rotate(30deg);"></div>
        <div style="position: absolute; bottom: 60px; right: 60px; width: 40px; height: 40px; border: 3px solid rgba(245, 127, 23, 0.2); transform: rotate(20deg);"></div>
        
        <div style="position: relative; z-index: 2;">
            <div style="background: white; width: 90px; height: 90px; border-radius: 18px; margin: 0 auto 25px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15); transform: rotate(-5deg); transition: all 0.3s ease;">
                <span style="font-size: 40px;">📧</span>
            </div>
            <h1 style="color: #424242; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">${subject}</h1>
            <div style="width: 80px; height: 4px; background: #F57F17; margin: 15px auto 0; border-radius: 2px;"></div>
        </div>
    </div>
    
    <!-- Main content -->
    <div style="padding: 40px 10px;">
        <!-- Message content with enhanced styling -->
        <div style="background: #FFFDE7; border-radius: 16px; padding: 35px; margin: 25px 0; position: relative; box-shadow: 0 4px 15px rgba(255, 193, 7, 0.1); border-left: 5px solid #FFC107;">
            <div style="position: absolute; top: -10px; left: 30px; width: 20px; height: 20px; background: #FFC107; transform: rotate(45deg);"></div>
            <div style="position: absolute; bottom: -10px; right: 30px; width: 20px; height: 20px; background: #FFC107; transform: rotate(45deg);"></div>
            
            <div style="color: #424242; font-size: 16px; line-height: 1.8; white-space: pre-line;">
                ${message.replace(/\n/g, '<br>')}
            </div>
        </div>
        
        <!-- Action section -->
        <div style="text-align: center; margin: 40px 0;">
            <div style="background: linear-gradient(to right, #FFF9C4, #FFECB3); padding: 30px; border-radius: 16px; margin-bottom: 25px; box-shadow: 0 5px 15px rgba(255, 193, 7, 0.1); border: 1px solid #FFE082;">
                <h3 style="color: #F57F17; margin: 0 0 15px 0; font-size: 20px; font-weight: 600;">📱 Take Action</h3>
                <p style="color: #424242; margin: 0 0 25px 0; font-size: 16px;">Ready to explore these recommendations?</p>
                <a href="https://toolmate-testing.netlify.app/dashboard" style="display: inline-block; background: linear-gradient(to right, #F57F17, #FF9800); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; box-shadow: 0 5px 15px rgba(245, 127, 23, 0.3); transition: all 0.3s ease;">
                    View Dashboard →
                </a>
            </div>
        </div>
        
        <!-- Additional resources -->
        <div style="background: #E8F5E9; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #2E7D32; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; text-align: center;">🔧 Helpful Resources</h4>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <div style="background: #E8F5E9; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #2E7D32; font-size: 20px;">📖</span>
                </div>
                <div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 500;">User Guides & Tutorials</p>
                    <a href="https://toolmate.com/guides" style="color: #F57F17; font-size: 13px; text-decoration: none;">Explore resources →</a>
                </div>
            </div>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <div style="background: #E8F5E9; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #2E7D32; font-size: 20px;">🎥</span>
                </div>
                <div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 500;">Video Tutorials</p>
                    <a href="https://toolmate.com/videos" style="color: #F57F17; font-size: 13px; text-decoration: none;">Watch tutorials →</a>
                </div>
            </div>
            
            <div style="display: flex; align-items: center; padding: 15px; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05);">
                <div style="background: #E8F5E9; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #2E7D32; font-size: 20px;">💬</span>
                </div>
                <div>
                    <p style="color: #424242; margin: 0; font-size: 14px; font-weight: 500;">Community Forum</p>
                    <a href="https://toolmate.com/community" style="color: #F57F17; font-size: 13px; text-decoration: none;">Join discussion →</a>
                </div>
            </div>
        </div>
        
        <!-- Divider with style -->
        <div style="text-align: center; margin: 40px 0;">
            <div style="display: inline-block; position: relative;">
                <div style="width: 120px; height: 2px; background: linear-gradient(to right, transparent, #FFC107, transparent);"></div>
                <div style="position: absolute; top: -6px; left: 50%; transform: translateX(-50%); width: 12px; height: 12px; background: #F57F17; border-radius: 50%;"></div>
            </div>
        </div>
        
        <!-- Footer notice -->
        <div style="background: #F5F5F5; padding: 25px; border-radius: 12px; text-align: center; border-left: 4px solid #FFC107;">
            <p style="color: #666; font-size: 14px; margin: 0; line-height: 1.6;">
                <strong style="color: #F57F17;">📬 Automated Message</strong><br>
                This is an automated message from Toolmate. Please do not reply to this email.<br>
                For support, visit <a href="https://toolmate.com/support" style="color: #F57F17; text-decoration: none; font-weight: 600;">our help center</a>
            </p>
        </div>
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 35px; text-align: center; color: white;">
        <div style="margin-bottom: 20px;">
            <div style="display: inline-block; background: #FFC107; width: 50px; height: 50px; border-radius: 14px; margin-bottom: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.2);">
                <span style="color: #424242; font-size: 24px; font-weight: bold; line-height: 50px;">T</span>
            </div>
        </div>
        <p style="margin: 0; color: #FFC107; font-size: 20px; font-weight: 700;">Toolmate Team</p>
        <p style="margin: 10px 0 20px 0; font-size: 14px; color: #E0E0E0;">Empowering your projects with the right tools</p>
        
        <div style="margin: 25px 0; display: flex; justify-content: center; gap: 15px;">
            <a href="https://twitter.com/toolmate" style="display: inline-block; width: 36px; height: 36px; background: #616161; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.3s ease;">
                <span style="color: white; font-size: 16px;"><svg style="width: 18px; height: 18px; fill: white;" viewBox="0 0 24 24">
          <path d="M22,12C22,10.6867 21.7413,9.38663 21.2388,8.1731C20.7362,6.95968 19.9996,5.85742 19.0711,4.9289C18.1425,4.00036 17.0403,3.26375 15.8269,2.76117C14.6134,2.25866 13.3133,2 12,2C10.6867,2 9.38663,2.25866 8.1731,2.76117C6.95968,3.26375 5.85742,4.00036 4.9289,4.9289C4.00036,5.85742 3.26375,6.95968 2.76117,8.1731C2.25866,9.38663 2,10.6867 2,12C2,17.5228 6.47715,22 12,22C12,21.7667 12,12 12,12C12,12 22,12 22,12Z" />
        </svg></span>
            </a>
            <a href="https://facebook.com/toolmate" style="display: inline-block; width: 36px; height: 36px; background: #616161; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.3s ease;">
                <span style="color: white; font-size: 16px;"><svg style="width: 18px; height: 18px; fill: white;" viewBox="0 0 24 24">
          <path d="M17,2V2H17V6H15C14.31,6 14,6.81 14,7.5V10H14L17,10V14H14V22H10V14H7V10H10V6A4,4 0 0,1 14,2H17Z" />
        </svg></span>
            </a>
            <a href="https://instagram.com/toolmate" style="display: inline-block; width: 36px; height: 36px; background: #616161; border-radius: 50%; display: flex; align-items: center; justify-content: center; transition: all 0.3s ease;">
                <span style="color: white; font-size: 16px;"> <svg style="width: 18px; height: 18px; fill: white;" viewBox="0 0 24 24">
          <path d="M22.46,6C21.69,6.35 20.86,6.58 20,6.69C20.88,6.16 21.56,5.32 21.88,4.31C21.05,4.81 20.13,5.16 19.16,5.36C18.37,4.5 17.26,4 16,4C13.65,4 11.73,5.92 11.73,8.29C11.73,8.63 11.77,8.96 11.84,9.27C8.28,9.09 5.11,7.38 3,4.79C2.63,5.42 2.42,6.16 2.42,6.94C2.42,8.43 3.17,9.75 4.33,10.5C3.62,10.5 2.96,10.3 2.38,10C2.38,10 2.38,10 2.38,10.03C2.38,12.11 3.86,13.85 5.82,14.24C5.46,14.34 5.08,14.39 4.69,14.39C4.42,14.39 4.15,14.36 3.89,14.31C4.43,16 6,17.26 7.89,17.29C6.43,18.45 4.58,19.13 2.56,19.13C2.22,19.13 1.88,19.11 1.54,19.07C3.44,20.29 5.7,21 8.12,21C16,21 20.33,14.46 20.33,8.79C20.33,8.6 20.33,8.42 20.32,8.23C21.16,7.63 21.88,6.87 22.46,6Z" />
        </svg></span>
            </a>
        </div>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. Crafted with ❤️ for tool enthusiasts</p>
            <p style="margin: 5px 0 0 0; font-size: 12px; color: #BDBDBD;">
                <a href="https://toolmate.com/unsubscribe" style="color: #BDBDBD; text-decoration: underline;">Unsubscribe</a> | 
                <a href="https://toolmate.com/privacy" style="color: #BDBDBD; text-decoration: underline;">Privacy Policy</a>
            </p>
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

  async sendNameChangedEmail(userEmail, userName, oldName, newName) {
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
        subject: 'Profile Name Updated Successfully',
        text: `Hi ${userName},\n\nYour profile name has been successfully updated.\n\nOld Name: ${oldName}\nNew Name: ${newName}\n\nIf you didn't make this change, please contact support immediately at help@toolmate.com.\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%); padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
        <!-- Decorative elements -->
        <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        
        <div style="background: white; width: 90px; height: 90px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
            <span style="font-size: 40px;">👤</span>
        </div>
        <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Profile Name Updated</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 16px;">Your account information has been successfully updated</p>
    </div>
    
    <!-- Main content -->
    <div style="padding: 40px 10px; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #424242; font-size: 24px; margin: 0 0 15px 0; font-weight: 700;">Hi ${userName}! ✨</h2>
        <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your profile name has been successfully updated in your Toolmate account.</p>
        
        <!-- Update details card -->
        <div style="background: #E8F5E9; border-left: 5px solid #4CAF50; padding: 25px; margin: 25px 0; border-radius: 0 12px 12px 0; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                <span style="background: #4CAF50; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 10px; color: white; font-size: 14px;">✓</span>
                Name Change Details
            </h3>
            <div style="display: flex; margin-bottom: 12px;">
                <div style="flex: 1;\">
                    <p style="color: #757575; margin: 0 0 5px 0; font-size: 13px; font-weight: 500;">Previous Name</p>
                    <p style="color: #424242; margin: 0; font-size: 16px; font-weight: 500;">${oldName}</p>
                </div>
                <div style="flex: 0 0 auto; display: flex; align-items: center; padding: 0 15px;">
                    <span style="color: #4CAF50; font-size: 20px;">→</span>
                </div>
                <div style="flex: 1; padding-left: 10px;">
                    <p style="color: #757575; margin: 0 0 5px 0; font-size: 13px; font-weight: 500;">New Name</p>
                    <p style="color: #424242; margin: 0; font-size: 16px; font-weight: 600;">${newName}</p>
                </div>
            </div>
        </div>
        
        <!-- Security notice -->
        <div style="background: #FFF3CD; border-left: 5px solid #FF9800; padding: 25px; margin: 30px 0; border-radius: 0 12px 12px 0; display: flex; align-items: flex-start;">
            <div style="background: #FF9800; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                <span style="color: white; font-size: 20px; font-weight: bold;">⚠️</span>
            </div>
            <div>
                <h4 style="color: #F57F17; margin: 0 0 10px 0; font-size: 16px; font-weight: 600;">Security Notice</h4>
                <p style="color: #424242; margin: 0; line-height: 1.5; font-size: 14px;">If you didn't make this change, please contact our support team immediately at <a href="mailto:help@toolmate.com" style="color: #F57F17; text-decoration: none; font-weight: 600;">help@toolmate.com</a></p>
            </div>
        </div>
        
        <!-- Next steps -->
        <div style="background: #E3F2FD; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; text-align: center;">📋 What's Next?</h4>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E3F2FD; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #1565C0; font-size: 16px; font-weight: bold;">1</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Your new name will appear across all Toolmate platforms</p>
            </div>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E3F2FD; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #1565C0; font-size: 16px; font-weight: bold;">2</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Update your name in any connected third-party services if needed</p>
            </div>
            
            <div style="display: flex; align-items: center; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E3F2FD; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #1565C0; font-size: 16px; font-weight: bold;">3</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Review your account settings for other personalization options</p>
            </div>
        </div>
        
        <!-- CTA Button -->
        <div style="text-align: center; margin: 40px 0 30px;">
            <a href="https://toolmate.com/account" style="display: inline-block; background: linear-gradient(to right, #4CAF50, #2E7D32); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; box-shadow: 0 5px 15px rgba(76, 175, 80, 0.3); transition: all 0.3s ease;">
                Review Account Settings
            </a>
        </div>
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 30px; text-align: center; color: white;">
        <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
        <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0 0 10px 0; font-size: 12px; color: #BDBDBD;">You're receiving this email because a change was made to your Toolmate account.</p>
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2025 Toolmate. All rights reserved.</p>
        </div>
    </div>
</div>
        `,
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'name_changed',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { oldName, newName },
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ Name changed email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send name changed email:', error);
      await this.logEmail({
        type: 'name_changed',
        recipient: userEmail,
        recipientName: userName,
        subject: 'Profile Name Updated Successfully',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }

  async sendEmailChangedEmail(userEmail, userName, oldEmail, newEmail) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key missing');
      }
      const msg = {
        to: newEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Security`,
        },
        subject: 'Email Address Updated Successfully',
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
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'email_changed',
        recipient: newEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { oldEmail, newEmail },
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ Email changed notification sent to:', newEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send email changed notification:', error);
      await this.logEmail({
        type: 'email_changed',
        recipient: newEmail,
        recipientName: userName,
        subject: 'Email Address Updated Successfully',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }

  async sendPasswordChangedEmail(userEmail, userName) {
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
        subject: 'Password Changed Successfully',
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
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'password_changed',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ Password changed email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send password changed email:', error);
      await this.logEmail({
        type: 'password_changed',
        recipient: userEmail,
        recipientName: userName,
        subject: 'Password Changed Successfully',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }

  async sendUserBannedEmail(userEmail, userName, reason = null) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key missing');
      }
      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Moderation`,
        },
        subject: 'Account Suspended - Action Required',
        text: `Hi ${userName},\n\nYour Toolmate account has been suspended due to a violation of our terms of service. If you believe this is an error, please contact our support team at help@toolmate.com with your account details.\n\nBest regards,\nThe Toolmate Moderation Team`,
        html: `
         <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #F44336 0%, #C62828 100%); padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
        <!-- Decorative elements -->
        <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        
        <div style="background: white; width: 90px; height: 90px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
            <span style="font-size: 40px;">🚫</span>
        </div>
        <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Account Suspended</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 16px;">Temporary account restriction</p>
    </div>
    
    <!-- Main content -->
    <div style="padding: 40px 10px; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #424242; font-size: 24px; margin: 0 0 15px 0; font-weight: 700;">Hi ${userName},</h2>
        <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your Toolmate account has been temporarily suspended due to a violation of our Terms of Service.</p>
        
        <!-- Status alert -->
        <div style="background: #FFEBEE; border-left: 5px solid #F44336; padding: 25px; margin: 25px 0; border-radius: 0 12px 12px 0;">
            <h3 style="color: #C62828; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                Account Status: Suspended
            </h3>
            <p style="color: #424242; margin: 0; font-size: 14px; line-height: 1.6;">
                During this suspension, you will not be able to access your Toolmate account or any associated services.
            </p>
        </div>
        
        <!-- Next steps -->
        <div style="background: #FFF3E0; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #EF6C00; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; text-align: center;">📋 What You Can Do</h4>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #FFF3E0; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #EF6C00; font-size: 16px; font-weight: bold;">1</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Review our <a href="https://toolmate.com/terms" style="color: #F57F17; text-decoration: none; font-weight: 500;">Terms of Service</a> to understand our guidelines</p>
            </div>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #FFF3E0; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #EF6C00; font-size: 16px; font-weight: bold;">2</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Contact our support team if you believe this is an error</p>
            </div>
            
            <div style="display: flex; align-items: center; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #FFF3E0; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #EF6C00; font-size: 16px; font-weight: bold;">3</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Provide any relevant information to help resolve the issue</p>
            </div>
        </div>
        
        <!-- Appeal process -->
        <div style="background: #E8F5E9; border-left: 5px solid #4CAF50; padding: 25px; margin: 30px 0; border-radius: 0 12px 12px 0;">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                <span style="background: #4CAF50; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 10px; color: white; font-size: 14px;">✓</span>
                Appeal Process
            </h3>
            <p style="color: #424242; margin: 0 0 20px 0; font-size: 14px; line-height: 1.6;">
                If you believe this suspension was made in error, please contact our support team with your account details.
            </p>
            <div style="text-align: center;">
                <a href="mailto:help@toolmate.com" style="display: inline-block; background: linear-gradient(to right, #4CAF50, #2E7D32); color: white; padding: 14px 35px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3);">
                    Contact Support
                </a>
            </div>
        </div>
        
        <!-- Additional info -->
        <div style="background: #F5F5F5; padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center;">
            <p style="color: #666; margin: 0; font-size: 13px; line-height: 1.5;">
                <strong>Please include in your email:</strong><br>
                • Your account username or email<br>
                • A description of why you believe the suspension is an error<br>
                • Any relevant information that may help us investigate
            </p>
        </div>
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 30px; text-align: center; color: white;">
        <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
        <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Moderation Team</p>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0 0 10px 0; font-size: 12px; color: #BDBDBD;">This is an automated message. Please do not reply to this email.</p>
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. All rights reserved.</p>
        </div>
    </div>
</div>
        `,
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'user_banned',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { reason },
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ User banned email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send user banned email:', error);
      await this.logEmail({
        type: 'user_banned',
        recipient: userEmail,
        recipientName: userName,
        subject: 'Account Suspended - Action Required',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }

  async sendUserUnbannedEmail(userEmail, userName) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key missing');
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Support`,
        },
        subject: 'Welcome Back! Account Reactivated',
        text: `Hi ${userName},\n\nGreat news! Your Toolmate account has been reactivated and you now have full access to all features.\n\nThank you for your patience during the review process.\n\nWelcome back!\n\nBest regards,\nThe Toolmate Team`,
        html: `
          <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #4CAF50 0%, #2E7D32 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden;">
        <!-- Decorative elements -->
        <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        
        <!-- Confetti elements -->
        <div style="position: absolute; top: 20px; left: 20%; width: 12px; height: 12px; background: rgba(255,255,255,0.6); border-radius: 50%; transform: rotate(45deg);"></div>
        <div style="position: absolute; top: 40px; left: 70%; width: 10px; height: 10px; background: rgba(255,255,255,0.5); border-radius: 50%; transform: rotate(30deg);"></div>
        <div style="position: absolute; top: 60px; left: 40%; width: 8px; height: 8px; background: rgba(255,255,255,0.4); border-radius: 50%;"></div>
        
        <div style="background: white; width: 100px; height: 100px; border-radius: 50%; margin: 0 auto 25px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
            <span style="font-size: 48px;">🎉</span>
        </div>
        <h1 style="color: white; margin: 0; font-size: 36px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Welcome Back!</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 18px;">Your account has been reactivated!</p>
    </div>
    
    <!-- Main content -->
    <div style="padding: 40px 10px; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #424242; font-size: 26px; margin: 0 0 15px 0; font-weight: 700;">Hi ${userName}! 🎊</h2>
        <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Great news! Your Toolmate account has been reactivated and you now have full access to all features.</p>
        
        <!-- Status card -->
        <div style="background: #E8F5E9; border-left: 5px solid #4CAF50; padding: 25px; margin: 25px 0; border-radius: 0 12px 12px 0; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
            <h3 style="color: #2E7D32; margin: 0 0 15px 0; font-size: 20px; font-weight: 600; display: flex; align-items: center;">
                Account Status: <span style="color: #2E7D32; margin-left: 5px;">Active</span>
            </h3>
            <p style="color: #424242; margin: 0; font-size: 16px;">You can now access all Toolmate features and services without any restrictions.</p>
        </div>
        
        <!-- CTA Button -->
        <div style="text-align: center; margin: 40px 0;">
            <a href="https://toolmate.com/dashboard" style="display: inline-block; background: linear-gradient(to right, #4CAF50, #2E7D32); color: white; padding: 18px 45px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 18px; box-shadow: 0 5px 15px rgba(76, 175, 80, 0.3); transition: all 0.3s ease;">
                🚀 Continue to Dashboard
            </a>
            <p style="color: #757575; font-size: 14px; margin-top: 15px;">Get back to your projects and tools!</p>
        </div>
        
        <!-- Quick access section -->
        <div style="background: #FFF3E0; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #EF6C00; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; text-align: center;">⚡ Quick Access</h4>
            
            <div style="display: flex; flex-wrap:wrap; justify-content: center; gap: 15px; margin-bottom: 20px;">
                <a href="https://toolmate.com/projects" style="display: inline-block; background: white; color: #4CAF50; padding: 12px 20px; text-decoration: none; border-radius: 20px; font-weight: 500; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid #4CAF50;">
                    My Projects
                </a>
                <a href="https://toolmate.com/tools" style="display: inline-block; background: white; color: #4CAF50; padding: 12px 20px; text-decoration: none; border-radius: 20px; font-weight: 500; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid #4CAF50;">
                    My Tools
                </a>
                <a href="https://toolmate.com/community" style="display: inline-block; background: white; color: #4CAF50; padding: 12px 20px; text-decoration: none; border-radius: 20px; font-weight: 500; font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid #4CAF50;">
                    Community
                </a>
            </div>
        </div>
        
        <!-- Thank you message -->
        <div style="background: #FFF9C4; border-left: 5px solid #FFC107; padding: 25px; margin: 30px 0; border-radius: 0 12px 12px 0; display: flex; align-items: flex-start;">
            <div style="background: #FFC107; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                <span style="color: white; font-size: 20px;">💛</span>
            </div>
            <div>
                <h4 style="color: #F57F17; margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Thank You!</h4>
                <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.5;">Thank you for your patience during the review process. We're excited to have you back in our community!</p>
            </div>
        </div>
        
        <!-- Support info -->
        <div style="background: #E3F2FD; padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center;">
            <p style="color: #1565C0; margin: 0; font-size: 14px; font-weight: 500;">
                Need help? Our support team is always here for you at <a href="mailto:help@toolmate.com" style="color: #1565C0; text-decoration: none; font-weight: 600;">help@toolmate.com</a>
            </p>
        </div>
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 30px; text-align: center; color: white;">
        <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
        <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. All rights reserved.</p>
        </div>
    </div>
</div>
        `,
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'user_unbanned',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ User unbanned email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send user unbanned email:', error);
      await this.logEmail({
        type: 'user_unbanned',
        recipient: userEmail,
        recipientName: userName,
        subject: 'Welcome Back! Account Reactivated',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }

  async sendRoleChangedEmail(userEmail, userName, oldRole, newRole) {
    try {
      if (!SENDGRID_API_KEY) {
        throw new Error('SendGrid API key missing');
      }

      const msg = {
        to: userEmail,
        from: {
          email: FROM_EMAIL,
          name: `${FROM_NAME} Admin`,
        },
        subject: 'Account Role Updated',
        text: `Hi ${userName},\n\nYour account role has been updated in Toolmate.\n\nPrevious Role: ${oldRole}\nNew Role: ${newRole}\n\nThis change may affect your access permissions. If you have any questions, please contact support at help@toolmate.com.\n\nBest regards,\nThe Toolmate Team`,
        html: `
         <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 5px 15px rgba(0,0,0,0.1);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #9C27B0 0%, #7B1FA2 100%); padding: 40px 30px; text-align: center; position: relative; overflow: hidden;">
        <!-- Decorative elements -->
        <div style="position: absolute; top: -20px; left: -20px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        <div style="position: absolute; bottom: -30px; right: -30px; width: 120px; height: 120px; background: rgba(255,255,255,0.1); border-radius: 50%;"></div>
        
        <div style="background: white; width: 90px; height: 90px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0,0,0,0.15);">
            <span style="font-size: 40px;">👑</span>
        </div>
        <h1 style="color: white; margin: 0; font-size: 32px; font-weight: 700; text-shadow: 0 2px 4px rgba(0,0,0,0.2);">Role Updated</h1>
        <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0; font-size: 16px;">Your account permissions have been changed</p>
    </div>
    
    <!-- Main content -->
    <div style="padding: 40px 10px; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #424242; font-size: 24px; margin: 0 0 15px 0; font-weight: 700;">Hi ${userName}! 🎭</h2>
        <p style="color: #666; font-size: 16px; line-height: 1.6; margin: 0 0 25px 0;">Your account role has been updated in Toolmate. This change may affect your access permissions.</p>
        
        <!-- Role change details -->
        <div style="background: #F3E5F5; border-left: 5px solid #9C27B0; padding: 25px; margin: 25px 0; border-radius: 0 12px 12px 0; box-shadow: 0 4px 10px rgba(0,0,0,0.05);">
            <h3 style="color: #7B1FA2; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
              
                Role Change Details
            </h3>
            <div style="display: flex; margin-bottom: 12px;">
                <div style="flex: 1;">
                    <p style="color: #757575; margin: 0 0 5px 0; font-size: 13px; font-weight: 500;">Previous Role</p>
                    <p style="color: #424242; margin: 0; font-size: 16px; font-weight: 500;">${oldRole}</p>
                </div>
                <div style="flex: 0 0 auto; display: flex; align-items: center; padding: 0 15px;">
                    <span style="color: #9C27B0; font-size: 20px;">→</span>
                </div>
                <div style="flex: 1; padding-left: 10px;">
                    <p style="color: #757575; margin: 0 0 5px 0; font-size: 13px; font-weight: 500;">New Role</p>
                    <p style="color: #424242; margin: 0; font-size: 16px; font-weight: 600;">${newRole}</p>
                </div>
            </div>
        </div>
        
        <!-- What this means -->
        <div style="background: #E3F2FD; border-left: 5px solid #2196F3; padding: 25px; margin: 30px 0; border-radius: 0 12px 12px 0;">
            <h3 style="color: #1565C0; margin: 0 0 15px 0; font-size: 18px; font-weight: 600; display: flex; align-items: center;">
                <span style="background: #2196F3; width: 24px; height: 24px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; margin-right: 10px; color: white; font-size: 14px;">ℹ</span>
                What This Means
            </h3>
            <p style="color: #424242; margin: 0 0 20px 0; font-size: 14px; line-height: 1.6;">
                Your new role may grant you additional permissions or modify your current access level. If you have questions about your new permissions, please contact support.
            </p>
            <div style="background: #FFF3E0; padding: 15px; border-radius: 8px;">
                <p style="color: #424242; margin: 0; font-size: 13px; line-height: 1.5;">
                    <strong>Tip:</strong> You may need to log out and log back in for all permission changes to take effect.
                </p>
            </div>
        </div>
        
        <!-- Permission highlights -->
        <div style="background: #E8F5E9; padding: 25px; border-radius: 12px; margin: 30px 0;">
            <h4 style="color: #2E7D32; margin: 0 0 20px 0; font-size: 18px; font-weight: 600; text-align: center;">🔑 Explore Your New Permissions</h4>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E8F5E9; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #2E7D32; font-size: 16px; font-weight: bold;">1</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Check your updated access rights in the dashboard</p>
            </div>
            
            <div style="display: flex; align-items: center; margin-bottom: 15px; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E8F5E9; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #2E7D32; font-size: 16px; font-weight: bold;">2</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Review any new features available with your role</p>
            </div>
            
            <div style="display: flex; align-items: center; padding: 12px; background: white; border-radius: 8px;">
                <div style="background: #E8F5E9; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; flex-shrink: 0;">
                    <span style="color: #2E7D32; font-size: 16px; font-weight: bold;">3</span>
                </div>
                <p style="color: #424242; margin: 0; font-size: 14px;">Contact support if you encounter any access issues</p>
            </div>
        </div>
        
        <!-- CTA Button -->
        <div style="text-align: center; margin: 40px 0 30px;">
            <a href="https://toolmate.com/dashboard" style="display: inline-block; background: linear-gradient(to right, #9C27B0, #7B1FA2); color: white; padding: 16px 40px; text-decoration: none; border-radius: 30px; font-weight: 600; font-size: 16px; box-shadow: 0 5px 15px rgba(156, 39, 176, 0.3); transition: all 0.3s ease;">
                🚀 Explore Your Dashboard
            </a>
        </div>
        
        <!-- Support info -->
        <div style="background: #F5F5F5; padding: 20px; border-radius: 8px; margin: 30px 0; text-align: center;">
            <p style="color: #666; margin: 0; font-size: 14px; line-height: 1.5;">
                <strong>Need help?</strong> Contact our support team at <a href="mailto:help@toolmate.com" style="color: #9C27B0; text-decoration: none; font-weight: 600;">help@toolmate.com</a>
            </p>
        </div>
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 30px; text-align: center; color: white;">
        <p style="margin: 0 0 8px 0; font-size: 16px; font-weight: 600;">Best regards,</p>
        <p style="margin: 0; color: #FFC107; font-size: 18px; font-weight: 700;">The Toolmate Team</p>
        
        <div style="margin-top: 20px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. All rights reserved.</p>
        </div>
    </div>
</div>
        `,
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'role_changed',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { oldRole, newRole },
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ Role changed email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send role changed email:', error);
      await this.logEmail({
        type: 'role_changed',
        recipient: userEmail,
        recipientName: userName,
        subject: 'Account Role Updated',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }

  async sendSubscriptionGiftedEmail(userEmail, userName, giftedBy = 'Toolmate') {
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
        subject: '🎁 Surprise! Premium Subscription Gifted to You',
        text: `Hi ${userName},\n\nAmazing news! You've been gifted a premium subscription by ${giftedBy}!\n\nYour premium features are now active and you can enjoy:\n- Unlimited AI tool recommendations\n- Priority support\n- Advanced analytics\n- Exclusive beta features\n\nStart exploring your premium benefits today!\n\nBest regards,\nThe Toolmate Team`,
        html: `
         <div style="font-family: 'Poppins', Tahoma, Geneva, Verdana, sans-serif; max-width: 650px; margin: 0 auto; background: linear-gradient(135deg, #FFD700 0%, #FFA000 100%); border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.15);">
    <!-- Header -->
    <div style="background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); padding: 50px 30px; text-align: center; position: relative; overflow: hidden;">
        <!-- Animated decorative elements -->
        <div style="position: absolute; top: 20px; left: 20px; width: 40px; height: 40px; background: rgba(255,255,255,0.2); border-radius: 50%;"></div>
        <div style="position: absolute; top: 60px; right: 30px; width: 25px; height: 25px; background: rgba(255,255,255,0.3); transform: rotate(45deg);"></div>
        <div style="position: absolute; bottom: 30px; left: 60px; width: 30px; height: 30px; background: rgba(255,255,255,0.2); border-radius: 50%;"></div>
        <div style="position: absolute; top: 40px; right: 60px; width: 20px; height: 20px; background: rgba(255,255,255,0.25); transform: rotate(30deg);"></div>
        
        <div style="position: relative; z-index: 2;">
            <div style="background: white; width: 110px; height: 110px; border-radius: 50%; margin: 0 auto 25px; display: flex; align-items: center; justify-content: center; box-shadow: 0 10px 30px rgba(0,0,0,0.2); border: 4px solid #FFB300;">
                <span style="font-size: 52px;">🎁</span>
            </div>
            <h1 style="color: white; margin: 0; font-size: 36px; font-weight: 800; text-shadow: 0 2px 4px rgba(0,0,0,0.3); letter-spacing: 0.5px;">Premium Gifted!</h1>
            <p style="color: rgba(255,255,255,0.95); margin: 10px 0 0 0; font-size: 18px; font-weight: 500;">You've received an amazing gift!</p>
        </div>
    </div>
    
    <!-- Main content -->
    <div style="padding: 50px 10px; background: white;">
        <div style="text-align: center; margin-bottom: 40px;">
            <h2 style="color: #FF6B35; font-size: 30px; margin: 0 0 15px 0; font-weight: 800;">Hi ${userName}! 🌟</h2>
            <p style="color: #424242; font-size: 18px; line-height: 1.6; margin: 0;">Amazing news! You've been gifted a premium subscription by <strong style="color: #FF6B35;">${giftedBy}</strong>!</p>
        </div>
        
        <!-- Gift details -->
        <div style="background: linear-gradient(135deg, #FFF8E1 0%, #FFECB3 100%); border: 3px dashed #FFB300; padding: 35px; border-radius: 20px; margin: 40px 0; text-align: center; position: relative;">
            <div style="position: absolute; top: -15px; left: 50%; transform: translateX(-50%); background: #FF6B35; color: white; padding: 10px 25px; border-radius: 20px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 10px rgba(255, 107, 53, 0.3);">🎉 PREMIUM ACTIVATED</div>
            <h3 style="color: #FF8F00; margin: 25px 0 25px 0; font-size: 24px; font-weight: 700;">Your Premium Benefits:</h3>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 25px; margin-top: 25px;">
                <div style="text-align: center;">
                    <div style="background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(255, 107, 53, 0.3);">
                        <span style="color: white; font-size: 24px;">🚀</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 15px; font-weight: 600;">Unlimited AI Recommendations</p>
                </div>
                <div style="text-align: center;">
                    <div style="background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(255, 107, 53, 0.3);">
                        <span style="color: white; font-size: 24px;">⚡</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 15px; font-weight: 600;">Priority Support</p>
                </div>
                <div style="text-align: center;">
                    <div style="background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(255, 107, 53, 0.3);">
                        <span style="color: white; font-size: 24px;">📊</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 15px; font-weight: 600;">Advanced Analytics</p>
                </div>
                <div style="text-align: center;">
                    <div style="background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); width: 60px; height: 60px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(255, 107, 53, 0.3);">
                        <span style="color: white; font-size: 24px;">🔬</span>
                    </div>
                    <p style="color: #424242; margin: 0; font-size: 15px; font-weight: 600;">Exclusive Beta Features</p>
                </div>
            </div>
        </div>
        
        <!-- CTA Button -->
        <div style="text-align: center; margin: 50px 0;">
            <a href="https://toolmate.com/dashboard" style="display: inline-block; background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); color: white; padding: 20px 45px; text-decoration: none; border-radius: 50px; font-weight: 700; font-size: 18px; box-shadow: 0 8px 25px rgba(255, 107, 53, 0.4); letter-spacing: 0.5px; transition: all 0.3s ease; position: relative; overflow: hidden;">
                <span style="position: relative; z-index: 2;">🎯 Start Using Premium Now</span>
                <div style="position: absolute; top: 0; left: -100%; width: 100%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent); transition: all 0.6s ease; transform: skewX(-25deg);"></div>
            </a>
        </div>
        
        <!-- Thank you note -->
        <div style="background: #F3E5F5; border-left: 6px solid #9C27B0; padding: 30px; border-radius: 0 15px 15px 0; margin: 40px 0; position: relative;">
            <div style="position: absolute; top: -12px; right: 20px; width: 24px; height: 24px; background: #9C27B0; border-radius: 50%; display: flex; align-items: center; justify-content: center;">
                <span style="color: white; font-size: 14px; font-weight: bold;">❤️</span>
            </div>
            <h4 style="color: #7B1FA2; margin: 0 0 15px 0; font-size: 20px; font-weight: 600;">💜 A Special Thank You</h4>
            <p style="color: #424242; margin: 0; font-size: 16px; line-height: 1.6;">This premium subscription is a gift from <strong style="color: #7B1FA2;">${giftedBy}</strong>. Make sure to thank them for this amazing gesture!</p>
        </div>
        
    </div>
    
    <!-- Footer -->
    <div style="background: #424242; padding: 40px 30px; text-align: center; color: white;">
        <div style="margin-bottom: 20px;">
            <div style="display: inline-block; background: linear-gradient(135deg, #FF6B35 0%, #F7931E 100%); width: 60px; height: 60px; border-radius: 50%; margin-bottom: 15px; box-shadow: 0 4px 10px rgba(0,0,0,0.2);">
                <span style="color: white; font-size: 28px; font-weight: bold; line-height: 60px;">T</span>
            </div>
        </div>
        <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: 600;">Enjoy your premium experience!</p>
        <p style="margin: 0; color: #FFC107; font-size: 22px; font-weight: 700;">The Toolmate Team</p>
        
        <div style="margin: 25px 0; display: flex; justify-content: center; gap: 15px;">
            <a href="https://toolmate.com/features" style="display: inline-block; background: #616161; color: white; padding: 10px 20px; text-decoration: none; border-radius: 20px; font-weight: 500; font-size: 14px;">
                Explore Features
            </a>
            <a href="https://toolmate.com/tutorials" style="display: inline-block; background: #616161; color: white; padding: 10px 20px; text-decoration: none; border-radius: 20px; font-weight: 500; font-size: 14px;">
                View Tutorials
            </a>
        </div>
        
        <div style="margin-top: 25px; padding-top: 20px; border-top: 1px solid #616161;">
            <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 Toolmate. Crafted with ❤️ for premium users</p>
        </div>
    </div>
</div>

<style>
    @keyframes bounce {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-10px); }
    }
    
    @keyframes float {
        0%, 100% { transform: translateY(0); }
        50% { transform: translateY(-8px); }
    }
    
    a:hover div {
        left: 100%;
    }
    
    a:hover {
        box-shadow: 0 10px 30px rgba(255, 107, 53, 0.5);
        transform: translateY(-2px);
    }
</style>
        `,
      };

      const response = await sgMail.send(msg);
      await this.logEmail({
        type: 'subscription_gifted',
        recipient: userEmail,
        recipientName: userName,
        subject: msg.subject,
        metadata: { giftedBy },
        sendgridResponse: response[0],
        success: true,
      });

      console.log('✅ Subscription gifted email sent to:', userEmail);
      return { success: true, response: response[0] };
    } catch (error) {
      console.error('❌ Failed to send subscription gifted email:', error);
      await this.logEmail({
        type: 'subscription_gifted',
        recipient: userEmail,
        recipientName: userName,
        subject: '🎁 Surprise! Premium Subscription Gifted to You',
        error: error.message,
        success: false,
      });
      return { success: false, error: error.message };
    }
  }
}

module.exports = EmailService;
