import { Router } from "express";
import { openDirectConversation } from "./conversation.service.js";

const router = Router();

router.post("/direct", async (req, res, next) => {
  try {
    const conversation = await openDirectConversation(req.user.id, req.body?.recipientUserId);
    res.status(200).json({ conversation });
  } catch (error) {
    next(error);
  }
});

export default router;
