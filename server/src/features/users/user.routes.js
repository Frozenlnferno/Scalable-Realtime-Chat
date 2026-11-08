import { Router } from "express";
import { listDirectory } from "./user.service.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    res.json({ currentUser: req.user, users: await listDirectory(req.user.id) });
  } catch (error) {
    next(error);
  }
});

export default router;
