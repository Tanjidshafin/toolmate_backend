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
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width:full; margin: 0 auto; background: white; position: relative;">
                  <!-- Hexagonal Header -->
                  <div style="background: linear-gradient(45deg, #FFC107 0%, #FFEB3B 50%, #FFF176 100%); height: 300px; position: relative; overflow: hidden; clip-path: polygon(0 0, 100% 0, 100% 75%, 50% 100%, 0 75%);">
                    <!-- Floating hexagons -->
                    <div style="position: absolute; top: 20px; left: 50px; width: 60px; height: 60px; background: rgba(245, 127, 23, 0.3); clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); animation: float 6s ease-in-out infinite;"></div>
                    <div style="position: absolute; top: 80px; right: 80px; width: 40px; height: 40px; background: rgba(255, 255, 255, 0.4); clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); animation: float 4s ease-in-out infinite reverse;"></div>
                    <div style="position: absolute; bottom: 60px; left: 80px; width: 30px; height: 30px; background: rgba(245, 127, 23, 0.5); clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); animation: float 5s ease-in-out infinite;"></div>
                    
                    <!-- Main content -->
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); text-align: center; z-index: 10;">
                      <div style="background: white; width: 120px; height: 120px; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); margin: 0 auto 30px; display: flex; align-items: center; justify-content: center; box-shadow: 0 15px 35px rgba(0,0,0,0.2);">
                        <span style="font-size: 48px;">🚀</span>
                      </div>
                      <h1 style="color: #424242; margin: 0; font-size: 36px; font-weight: 900; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); letter-spacing: -1px;">WELCOME</h1>
                      <div style="background: #F57F17; height: 6px; width: 100px; margin: 15px auto; clip-path: polygon(10% 0%, 90% 0%, 100% 100%, 0% 100%);"></div>
                    </div>
                  </div>
                  
                  <!-- Overlapping content section -->
                  <div style="background: white; margin-top: -50px; position: relative; z-index: 5; border-radius: 30px 30px 0 0; padding: 60px 30px 40px;">
                    <div style="text-align: center; margin-bottom: 40px;">
                      <h2 style="color: #F57F17; font-size: 28px; margin: 0 0 20px 0; font-weight: 800; position: relative;">
                        Hey ${userName}! 
                        <div style="position: absolute; top: -10px; right: -20px; background: #FFC107; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px;">👋</div>
                      </h2>
                      <p style="color: #666; font-size: 18px; line-height: 1.7; margin: 0; max-width: 400px; margin: 0 auto;">You've just unlocked the ultimate toolkit experience!</p>
                    </div>
                    
                    <!-- Zigzag feature section -->
                    <div style="position: relative; margin: 50px 0;">
                      <div style="background: #FFFDE7; padding: 40px 30px; position: relative; clip-path: polygon(0 10%, 100% 0, 100% 90%, 0 100%);">
                        <h3 style="color: #F57F17; margin: 0 0 25px 0; font-size: 22px; font-weight: 700; text-align: center;">🎯 Your Superpowers Await</h3>
                        <div style="display: grid; gap: 20px;">
                          <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="background: #FFC107; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">🤖</div>
                            <div style="color: #424242; font-weight: 600;">AI-Powered Recommendations</div>
                          </div>
                          <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="background: #FFEB3B; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">🏗️</div>
                            <div style="color: #424242; font-weight: 600;">Personal Tool Shed Builder</div>
                          </div>
                          <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="background: #FFF176; width: 50px; height: 50px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">💎</div>
                            <div style="color: #424242; font-weight: 600;">Curated Hidden Gems</div>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    <!-- Explosive CTA -->
                    <div style="text-align: center; margin: 50px 0; position: relative;">
                      <div style="position: absolute; top: -20px; left: 50%; transform: translateX(-50%); width: 200px; height: 80px; background: radial-gradient(circle, rgba(255, 193, 7, 0.3) 0%, transparent 70%); border-radius: 50%;"></div>
                      <a href="https://toolmate.com" style="display: inline-block; background: linear-gradient(45deg, #F57F17 0%, #FF9800 100%); color: white; padding: 20px 50px; text-decoration: none; border-radius: 50px; font-weight: 800; font-size: 18px; box-shadow: 0 10px 30px rgba(245, 127, 23, 0.4); position: relative; z-index: 2; text-transform: uppercase; letter-spacing: 2px; transition: all 0.3s ease;">
                        🚀 BLAST OFF NOW!
                      </a>
                      <div style="margin-top: 20px; color: #F57F17; font-weight: 600; font-size: 14px;">⚡ 50,000+ users already launched!</div>
                    </div>
                  </div>
                  
                  <!-- Geometric footer -->
                  <div style="background: #424242; position: relative; padding: 40px 30px; clip-path: polygon(0 20%, 100% 0, 100% 100%, 0 100%);">
                    <div style="text-align: center; color: white; margin-top: 20px;">
                      <div style="background: #FFC107; width: 60px; height: 60px; clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%); margin: 0 auto 20px; display: flex; align-items: center; justify-content: center;">
                        <span style="color: #424242; font-size: 24px; font-weight: 900;">T</span>
                      </div>
                      <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: 700;">The Toolmate Crew</p>
                      <p style="margin: 0; font-size: 12px; color: #BDBDBD;">© 2024 • Crafted with ⚡ for innovators</p>
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
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background: white; position: relative;">
                  <!-- Orbital Header -->
                  <div style="background: radial-gradient(circle at center, #FFC107 0%, #FFEB3B 40%, #FFF176 100%); height: 280px; position: relative; overflow: hidden; border-radius: 0 0 50% 50%;">
                    <!-- Orbiting elements -->
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 200px; height: 200px; border: 3px dashed rgba(245, 127, 23, 0.3); border-radius: 50%; animation: rotate 20s linear infinite;">
                      <div style="position: absolute; top: -15px; left: 50%; transform: translateX(-50%); width: 30px; height: 30px; background: #F57F17; border-radius: 50%; box-shadow: 0 4px 15px rgba(245, 127, 23, 0.4);"></div>
                    </div>
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 140px; height: 140px; border: 2px dashed rgba(255, 255, 255, 0.5); border-radius: 50%; animation: rotate 15s linear infinite reverse;">
                      <div style="position: absolute; top: -10px; left: 50%; transform: translateX(-50%); width: 20px; height: 20px; background: white; border-radius: 50%; opacity: 0.8;"></div>
                    </div>
                    
                    <!-- Central lock -->
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; width: 100px; height: 100px; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 15px 40px rgba(0,0,0,0.2); z-index: 10;">
                      <span style="font-size: 40px;">🔐</span>
                    </div>
                    
                    <!-- Floating particles -->
                    <div style="position: absolute; top: 30px; left: 100px; width: 8px; height: 8px; background: rgba(245, 127, 23, 0.6); border-radius: 50%; animation: float 3s ease-in-out infinite;"></div>
                    <div style="position: absolute; top: 60px; right: 120px; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.7); border-radius: 50%; animation: float 4s ease-in-out infinite reverse;"></div>
                    <div style="position: absolute; bottom: 40px; left: 150px; width: 6px; height: 6px; background: rgba(245, 127, 23, 0.8); border-radius: 50%; animation: float 2s ease-in-out infinite;"></div>
                  </div>
                  
                  <!-- Wave transition -->
                  <div style="background: white; margin-top: -1px; position: relative;">
                    <svg style="display: block; width: 100%; height: 50px;" viewBox="0 0 600 50" preserveAspectRatio="none">
                      <path d="M0,25 Q150,0 300,25 T600,25 L600,50 L0,50 Z" fill="#FFC107" opacity="0.3"/>
                      <path d="M0,35 Q150,10 300,35 T600,35 L600,50 L0,50 Z" fill="#FFEB3B" opacity="0.5"/>
                    </svg>
                  </div>
                  
                  <!-- Main content -->
                  <div style="padding: 40px 30px;">
                    <div style="text-align: center; margin-bottom: 40px;">
                      <h1 style="color: #424242; font-size: 32px; margin: 0 0 20px 0; font-weight: 900; position: relative;">
                        SECURITY UPDATED
                        <div style="position: absolute; top: -15px; right: -30px; background: #4CAF50; width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; font-size: 20px; font-weight: bold; animation: pulse 2s infinite;">✓</div>
                      </h1>
                      <p style="color: #666; font-size: 18px; line-height: 1.6; margin: 0;">Hey ${userName}, your digital fortress is now stronger than ever!</p>
                    </div>
                    
                    <!-- Success orbit -->
                    <div style="position: relative; margin: 50px 0; text-align: center;">
                      <div style="background: linear-gradient(135deg, #E8F5E8 0%, #C8E6C9 100%); border-radius: 50%; width: 200px; height: 200px; margin: 0 auto; position: relative; display: flex; align-items: center; justify-content: center; box-shadow: 0 20px 40px rgba(76, 175, 80, 0.2);">
                        <div style="position: absolute; top: -10px; left: 50%; transform: translateX(-50%); width: 220px; height: 220px; border: 3px dashed #4CAF50; border-radius: 50%; opacity: 0.3; animation: rotate 10s linear infinite;"></div>
                        <div style="text-align: center; z-index: 2;">
                          <div style="background: #4CAF50; width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; color: white; font-size: 36px; font-weight: bold;">✓</div>
                          <h3 style="color: #2E7D32; margin: 0; font-size: 18px; font-weight: 700;">PASSWORD SECURED</h3>
                        </div>
                      </div>
                    </div>
                    
                    <!-- Warning constellation -->
                    <div style="background: linear-gradient(135deg, #FFF8E1 0%, #FFECB3 100%); padding: 40px 30px; margin: 40px 0; border-radius: 30px; position: relative; overflow: hidden;">
                      <div style="position: absolute; top: 20px; right: 30px; width: 100px; height: 100px; border: 2px dashed rgba(255, 152, 0, 0.3); border-radius: 50%;"></div>
                      <div style="position: absolute; bottom: 20px; left: 30px; width: 60px; height: 60px; border: 1px dashed rgba(255, 152, 0, 0.2); border-radius: 50%;"></div>
                      
                      <div style="position: relative; z-index: 2;">
                        <div style="display: flex; align-items: center; gap: 20px; margin-bottom: 20px;">
                          <div style="background: linear-gradient(45deg, #FF9800 0%, #FFC107 100%); width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 24px; flex-shrink: 0; box-shadow: 0 8px 25px rgba(255, 152, 0, 0.3);">⚠️</div>
                          <div>
                            <h4 style="color: #F57F17; margin: 0 0 10px 0; font-size: 20px; font-weight: 700;">SECURITY ALERT</h4>
                            <p style="color: #424242; margin: 0; line-height: 1.6; font-size: 15px;">Didn't make this change? Contact our security team immediately!</p>
                          </div>
                        </div>
                        <div style="text-align: center; margin-top: 25px;">
                          <a href="mailto:help@toolmate.com" style="display: inline-block; background: linear-gradient(45deg, #F57F17 0%, #FF9800 100%); color: white; padding: 15px 35px; text-decoration: none; border-radius: 30px; font-weight: 700; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">🚨 CONTACT SECURITY</a>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <!-- Geometric footer -->
                  <div style="background: linear-gradient(135deg, #424242 0%, #616161 100%); padding: 40px 30px; position: relative; clip-path: polygon(0 0, 100% 25%, 100% 100%, 0 100%);">
                    <div style="text-align: center; color: white; position: relative; z-index: 2;">
                      <div style="background: linear-gradient(45deg, #FFC107 0%, #FFEB3B 100%); width: 70px; height: 70px; border-radius: 50%; margin: 0 auto 20px; display: flex; align-items: center; justify-content: center; position: relative;">
                        <span style="color: #424242; font-size: 28px; font-weight: 900;">🛡️</span>
                        <div style="position: absolute; top: -5px; right: -5px; width: 80px; height: 80px; border: 2px dashed rgba(255, 193, 7, 0.5); border-radius: 50%; animation: rotate 15s linear infinite;"></div>
                      </div>
                      <p style="margin: 0 0 10px 0; font-size: 18px; font-weight: 700;">Toolmate Security Division</p>
                      <p style="margin: 0; font-size: 12px; color: #BDBDBD;">🔒 Your security is our mission</p>
                    </div>
                  </div>
                  
                  <style>
                    @keyframes rotate {
                      from { transform: rotate(0deg); }
                      to { transform: rotate(360deg); }
                    }
                    @keyframes float {
                      0%, 100% { transform: translateY(0px); }
                      50% { transform: translateY(-10px); }
                    }
                    @keyframes pulse {
                      0%, 100% { transform: scale(1); }
                      50% { transform: scale(1.1); }
                    }
                  </style>
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
         <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; background: white; position: relative;">
                  <!-- Crystalline Header -->
                  <div style="background: linear-gradient(60deg, #FFC107 0%, #FFEB3B 35%, #FFF176 70%, #FFECB3 100%); height: 320px; position: relative; overflow: hidden; clip-path: polygon(0 0, 100% 0, 85% 100%, 15% 100%);">
                    <!-- Crystal formations -->
                    <div style="position: absolute; top: 40px; left: 80px; width: 0; height: 0; border-left: 25px solid transparent; border-right: 25px solid transparent; border-bottom: 50px solid rgba(245, 127, 23, 0.4); transform: rotate(15deg);"></div>
                    <div style="position: absolute; top: 60px; right: 100px; width: 0; height: 0; border-left: 20px solid transparent; border-right: 20px solid transparent; border-bottom: 40px solid rgba(255, 255, 255, 0.6); transform: rotate(-30deg);"></div>
                    <div style="position: absolute; bottom: 80px; left: 120px; width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-bottom: 30px solid rgba(245, 127, 23, 0.5); transform: rotate(45deg);"></div>
                    <div style="position: absolute; top: 100px; left: 200px; width: 0; height: 0; border-left: 18px solid transparent; border-right: 18px solid transparent; border-bottom: 36px solid rgba(255, 255, 255, 0.4); transform: rotate(-15deg);"></div>
                    <div style="position: absolute; bottom: 120px; right: 150px; width: 0; height: 0; border-left: 22px solid transparent; border-right: 22px solid transparent; border-bottom: 44px solid rgba(245, 127, 23, 0.3); transform: rotate(60deg);"></div>
                    
                    <!-- Central diamond -->
                    <div style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(45deg); background: white; width: 120px; height: 120px; display: flex; align-items: center; justify-content: center; box-shadow: 0 20px 50px rgba(0,0,0,0.2); z-index: 10;">
                      <div style="transform: rotate(-45deg); text-align: center;">
                        <span style="font-size: 48px; display: block; margin-bottom: 10px;">💎</span>
                        <div style="background: #F57F17; height: 4px; width: 60px; margin: 0 auto;"></div>
                      </div>
                    </div>
                    
                    <!-- Title -->
                    <div style="position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); text-align: center; z-index: 5;">
                      <h1 style="color: #424242; margin: 0; font-size: 32px; font-weight: 900; text-shadow: 2px 2px 4px rgba(0,0,0,0.1); letter-spacing: -1px;">${subject.toUpperCase()}</h1>
                    </div>
                  </div>
                  
                  <!-- Faceted content section -->
                  <div style="background: white; margin-top: -40px; position: relative; z-index: 5; padding: 60px 30px 40px;">
                    <!-- Message in crystal container -->
                    <div style="position: relative; margin: 40px 0;">
                      <div style="background: linear-gradient(135deg, #FFFDE7 0%, #FFF9C4 50%, #FFECB3 100%); padding: 40px 35px; position: relative; clip-path: polygon(5% 0%, 95% 0%, 100% 25%, 95% 100%, 5% 100%, 0% 75%); box-shadow: inset 0 4px 15px rgba(255, 193, 7, 0.2);">
                        <!-- Crystal edges -->
                        <div style="position: absolute; top: 0; left: 5%; width: 90%; height: 2px; background: linear-gradient(90deg, transparent 0%, #F57F17 50%, transparent 100%);"></div>
                        <div style="position: absolute; bottom: 0; left: 5%; width: 90%; height: 2px; background: linear-gradient(90deg, transparent 0%, #F57F17 50%, transparent 100%);"></div>
                        
                        <div style="color: #424242; font-size: 16px; line-height: 1.9; white-space: pre-line; position: relative; z-index: 2;">
                          ${message.replace(/\n/g, '<br>')}
                        </div>
                        
                        <!-- Floating gems -->
                        <div style="position: absolute; top: 15px; right: 25px; width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 16px solid rgba(245, 127, 23, 0.4); transform: rotate(30deg);"></div>
                        <div style="position: absolute; bottom: 20px; left: 30px; width: 0; height: 0; border-left: 6px solid transparent; border-right: 6px solid transparent; border-bottom: 12px solid rgba(255, 193, 7, 0.5); transform: rotate(-45deg);"></div>
                      </div>
                    </div>
                    
                    <!-- Prismatic CTA section -->
                    <div style="text-align: center; margin: 60px 0; position: relative;">
                      <div style="background: radial-gradient(circle, rgba(255, 193, 7, 0.2) 0%, transparent 70%); width: 300px; height: 150px; position: absolute; top: -30px; left: 50%; transform: translateX(-50%); border-radius: 50%;"></div>
                      
                      <div style="position: relative; z-index: 2;">
                        <h3 style="color: #F57F17; margin: 0 0 25px 0; font-size: 24px; font-weight: 800;">💫 READY TO SHINE?</h3>
                        <a href="https://toolmate.com/dashboard" style="display: inline-block; background: linear-gradient(45deg, #F57F17 0%, #FF9800 50%, #FFC107 100%); color: white; padding: 20px 45px; text-decoration: none; border-radius: 0; font-weight: 800; font-size: 16px; clip-path: polygon(10% 0%, 90% 0%, 100% 50%, 90% 100%, 10% 100%, 0% 50%); box-shadow: 0 15px 35px rgba(245, 127, 23, 0.4); text-transform: uppercase; letter-spacing: 2px; position: relative;">
                          ✨ EXPLORE DASHBOARD
                          <div style="position: absolute; top: -3px; left: -3px; right: -3px; bottom: -3px; background: linear-gradient(45deg, #FFC107, #FFEB3B); clip-path: polygon(10% 0%, 90% 0%, 100% 50%, 90% 100%, 10% 100%, 0% 50%); z-index: -1; opacity: 0.3;"></div>
                        </a>
                      </div>
                    </div>
                    
                    <!-- Geometric divider -->
                    <div style="text-align: center; margin: 50px 0;">
                      <div style="display: inline-flex; align-items: center; gap: 15px;">
                        <div style="width: 0; height: 0; border-left: 10px solid transparent; border-right: 10px solid transparent; border-bottom: 20px solid #FFC107; transform: rotate(45deg);"></div>
                        <div style="width: 40px; height: 3px; background: linear-gradient(90deg, #F57F17 0%, #FFC107 50%, #F57F17 100%);"></div>
                        <div style="background: #F57F17; width: 20px; height: 20px; transform: rotate(45deg);"></div>
                        <div style="width: 40px; height: 3px; background: linear-gradient(90deg, #F57F17 0%, #FFC107 50%, #F57F17 100%);"></div>
                        <div style="width: 0; height: 0; border-left: 10px solid transparent; border-right: 10px solid transparent; border-bottom: 20px solid #FFC107; transform: rotate(-45deg);"></div>
                      </div>
                    </div>
                    
                    <!-- Disclaimer in crystal -->
                    <div style="background: linear-gradient(135deg, #F5F5F5 0%, #EEEEEE 100%); padding: 25px; position: relative; clip-path: polygon(3% 0%, 97% 0%, 100% 20%, 97% 100%, 3% 100%, 0% 80%); border-left: 4px solid #FFC107;">
                      <p style="color: #666; font-size: 13px; margin: 0; line-height: 1.6; text-align: center;">
                        <strong style="color: #F57F17;">💎 AUTOMATED CRYSTAL MESSAGE</strong><br>
                        This is an automated message from Toolmate's AI system.<br>
                        For support, visit our <a href="https://toolmate.com/support" style="color: #F57F17; text-decoration: none; font-weight: 600;">crystalline help center</a>
                      </p>
                    </div>
                  </div>
                  
                  <!-- Multifaceted footer -->
                  <div style="background: linear-gradient(135deg, #424242 0%, #616161 50%, #424242 100%); padding: 50px 30px; position: relative; clip-path: polygon(0 0, 100% 30%, 100% 100%, 0 70%);">
                    <!-- Background crystals -->
                    <div style="position: absolute; top: 20px; left: 100px; width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-bottom: 30px solid rgba(255, 193, 7, 0.2); transform: rotate(15deg);"></div>
                    <div style="position: absolute; bottom: 30px; right: 120px; width: 0; height: 0; border-left: 12px solid transparent; border-right: 12px solid transparent; border-bottom: 24px solid rgba(255, 193, 7, 0.15); transform: rotate(-30deg);"></div>
                    
                    <div style="text-align: center; color: white; position: relative; z-index: 2;">
                      <div style="background: linear-gradient(45deg, #FFC107 0%, #FFEB3B 100%); width: 80px; height: 80px; transform: rotate(45deg); margin: 0 auto 25px; display: flex; align-items: center; justify-content: center; position: relative;">
                        <span style="color: #424242; font-size: 32px; font-weight: 900; transform: rotate(-45deg);">T</span>
                        <div style="position: absolute; top: -5px; left: -5px; right: -5px; bottom: -5px; border: 2px dashed rgba(255, 193, 7, 0.5); transform: rotate(45deg);"></div>
                      </div>
                      <p style="margin: 0 0 10px 0; font-size: 20px; font-weight: 800;">TOOLMATE NEXUS</p>
                      <p style="margin: 0; font-size: 12px; color: #BDBDBD;">💎 Where innovation crystallizes into reality</p>
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
