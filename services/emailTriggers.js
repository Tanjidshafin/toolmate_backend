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
        case "name_changed":
          result = await this.emailService.sendNameChangedEmail(userEmail, userName)
          break
        case "email_changed":
          result = await this.emailService.sendEmailChangedEmail(userEmail, userName)
          break
        case "password_changed":
          result = await this.emailService.sendPasswordChangedEmail(userEmail, userName)
          break
        case "role_changed":
          result = await this.emailService.sendRoleChangedEmail(userEmail, userName)
          break
        case "subscription_gifted":
          result = await this.emailService.sendSubscriptionGiftedEmail(userEmail, userName)
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
  async triggerNameChangedEmail(userEmail, userName, oldName, newName) {
    try {
      const result = await this.emailService.sendNameChangedEmail(userEmail, userName, oldName, newName)
      return result
    } catch (error) {
      console.error("❌ Name changed email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerEmailChangedEmail(userEmail, userName, oldEmail, newEmail) {
    try {
      const result = await this.emailService.sendEmailChangedEmail(userEmail, userName, oldEmail, newEmail)
      return result
    } catch (error) {
      console.error("❌ Email changed email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerPasswordChangedEmail(userEmail, userName) {
    try {
      const result = await this.emailService.sendPasswordChangedEmail(userEmail, userName)
      return result
    } catch (error) {
      console.error("❌ Password changed email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerUserBannedEmail(userEmail, userName, reason = null) {
    try {
      const result = await this.emailService.sendUserBannedEmail(userEmail, userName, reason)
      return result
    } catch (error) {
      console.error("❌ User banned email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerUserUnbannedEmail(userEmail, userName) {
    try {
      const result = await this.emailService.sendUserUnbannedEmail(userEmail, userName)
      return result
    } catch (error) {
      console.error("❌ User unbanned email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerRoleChangedEmail(userEmail, userName, oldRole, newRole) {
    try {
      const result = await this.emailService.sendRoleChangedEmail(userEmail, userName, oldRole, newRole)
      return result
    } catch (error) {
      console.error("❌ Role changed email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
  async triggerSubscriptionGiftedEmail(userEmail, userName, giftedBy = "Toolmate") {
    try {
      const result = await this.emailService.sendSubscriptionGiftedEmail(userEmail, userName, giftedBy)
      return result
    } catch (error) {
      console.error("❌ Subscription gifted email trigger failed:", error)
      return { success: false, error: error.message }
    }
  }
}
module.exports = EmailTriggers
