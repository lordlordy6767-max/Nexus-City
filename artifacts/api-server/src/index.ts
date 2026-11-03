import { createServer } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";
import { createRealtimeGame } from "./lib/realtime-game";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = createServer(app);
createRealtimeGame(server);

server.on("error", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
});

server.listen(port, () => {
  logger.info({ port }, "Server listening");
});
