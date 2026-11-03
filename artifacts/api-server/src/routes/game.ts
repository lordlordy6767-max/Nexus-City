import { Router, type IRouter } from "express";
import { GetGameInfoResponse } from "@workspace/api-zod";
import { getGameInfo } from "../lib/realtime-game";

const router: IRouter = Router();

router.get("/game/info", (_req, res) => {
  res.json(GetGameInfoResponse.parse(getGameInfo()));
});

export default router;
