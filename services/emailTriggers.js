class EmailTriggers {
  constructor(emailService) {
    this.emailService = emailService
  }
  async triggerWelcomeEmail(userData) {
    try {
      if (userData.userEmail && userData.userName) {
        const result = await this.emailService.sendWelcomeEmail(userData.userEmail, userData.userName)
        return result
      } else {
        console.warn("⚠️ Missing email or name for welcome email:", userData)
        return { success: false, error: "Missing email or name" }
      }
    } catch (error) {
      console.error("❌ Welcome email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerPasswordResetSuccessEmail(userEmail, userName) {
    try {
      const result = await this.emailService.sendPasswordResetSuccessEmail(userEmail, userName)
      return result
    } catch (error) {
      console.error("❌ Password reset success email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerSystemAlert(userEmail, userName, alertType, customMessage = null) {
    try {
      let result
      switch (alertType) {
        case "account_banned":
          result = await this.emailService.sendAccountBannedEmail(userEmail, userName)
          break
        case "account_unbanned":
          result = await this.emailService.sendAccountUnbannedEmail(userEmail, userName)
          break
        default:
          if (customMessage) {
            result = await this.emailService.sendSystemAlertEmail(userEmail, userName, alertType, customMessage)
          } else {
            throw new Error(`Unknown alert type: ${alertType}`)
          }
          break
      }
      return result
    } catch (error) {
      console.error("❌ System alert email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
}

module.exports = EmailTriggers
