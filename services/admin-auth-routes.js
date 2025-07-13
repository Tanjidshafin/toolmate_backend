const express = require("express")
const { ObjectId } = require("mongodb")
module.exports = ({ auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router()
  router.post("/api/v1/admin/login", (req, res) => {
    try {
      const { username, password } = req.body
      const userInfo = getUserInfoFromRequest(req)
      if (!username || !password) {
        return res.status(400).json({
          success: false,
          message: "Username and password are required",
        })
      }
      const adminEmail = process.env.EMAIL
      const adminPassword = process.env.PASSWORD
      if (!adminEmail || !adminPassword) {
        return res.status(500).json({
          success: false,
          message: "Server configuration error",
        })
      }
      if (username === adminEmail && password === adminPassword) {
        const userData = {
          username: "Allan Davis",
          role: ["all"],
          permissions: ["all"],
          userEmail: "help@toolmate.com",
        }
        // Log audit for admin login
        auditLogger.logAudit({
          action: "LOGIN",
          resource: "admin_session",
          resourceId: null,
          userId: "admin",
          userEmail: adminEmail,
          role: "admin",
          newData: {
            loginTime: new Date(),
            username: userData.username,
          },
          metadata: {
            adminAction: true,
            loginSuccess: true,
          },
          ...userInfo,
        })

        return res.status(200).json({
          success: true,
          message: "Login successful",
          ...userData,
        })
      } else {
        auditLogger.logAudit({
          action: "LOGIN_FAILED",
          resource: "admin_session",
          resourceId: null,
          userId: username,
          userEmail: username,
          role: "unknown",
          newData: {
            attemptTime: new Date(),
            username: username,
          },
          metadata: {
            adminAction: false,
            loginSuccess: false,
            failureReason: "invalid_credentials",
          },
          ...userInfo,
        })
        return res.status(401).json({
          success: false,
          message: "Invalid credentials",
        })
      }
    } catch (error) {
      console.error("Login error:", error)
      return res.status(500).json({
        success: false,
        message: "Internal server error",
      })
    }
  })

  return router
}
