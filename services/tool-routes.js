const express = require('express');
const { ObjectId } = require('mongodb');

module.exports = ({ toolsStorage, auditLogger, getUserInfoFromRequest }) => {
  const router = express.Router();
  router.post('/store-suggested-tools', async (req, res) => {
    try {
      const data = req.body;
      const userInfo = getUserInfoFromRequest(req);
      const existingUser = await toolsStorage.findOne({
        userEmail: data.userEmail,
        userName: data.userName,
      });
      if (existingUser) {
        const newToolsToAdd = data.suggestedTools.filter(
          (newTool) => !existingUser.suggestedTools.some((oldTool) => oldTool.id === newTool.id)
        );
        const updatedSuggestedTools = [...existingUser.suggestedTools, ...newToolsToAdd];
        const oldData = { suggestedTools: existingUser.suggestedTools };
        const result = await toolsStorage.updateOne(
          { _id: existingUser._id },
          { $set: { suggestedTools: updatedSuggestedTools } }
        );
        await auditLogger.logAudit({
          action: 'UPDATE',
          resource: 'suggested_tools',
          resourceId: existingUser._id.toString(),
          userId: data.userEmail,
          userEmail: data.userEmail,
          role: 'user',
          oldData,
          newData: { suggestedTools: updatedSuggestedTools },
          ...userInfo,
        });
        res.send({ updated: true, result });
      } else {
        const result = await toolsStorage.insertOne(data);
        await auditLogger.logAudit({
          action: 'CREATE',
          resource: 'suggested_tools',
          resourceId: result.insertedId.toString(),
          userId: data.userEmail,
          userEmail: data.userEmail,
          role: 'user',
          newData: data,
          ...userInfo,
        });
        res.send({ inserted: true, result });
      }
    } catch (error) {
      console.error('Error storing suggested tools:', error);
      res.status(500).send({ error: 'Internal server error' });
    }
  });

  router.get('/tools/:email', async (req, res) => {
    try {
      const email = req.params.email;
      const query = { userEmail: email };
      const result = await toolsStorage.findOne(query);
      res.send(result.suggestedTools);
    } catch (error) {
      res.status(500).send(error);
    }
  });

  return router;
};
