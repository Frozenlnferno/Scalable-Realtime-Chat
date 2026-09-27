import { Router } from "express";
import { getMessages, sendMessage } from "./message.service.js";

const router = Router();

router.get("/:conversationId/messages", async (req, res, next) => {
  try {
    res.json(await getMessages(req.params.conversationId, req.user.id, req.query.cursor));
  } catch (error) {
    next(error);
  }
});

router.post("/:conversationId/messages", async (req, res, next) => {
  try {
    const message = await sendMessage(req.params.conversationId, req.user.id, req.body?.body);
    res.status(201).json({ message });
  } catch (error) {
    next(error);
  }
});

export default router;
