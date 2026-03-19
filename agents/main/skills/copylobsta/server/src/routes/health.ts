import { Router } from "express";

const router = Router();

router.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "copylobsta", time: new Date().toISOString() });
});

export default router;
