import { serve } from "@hono/node-server";

import { app } from "./app.js";
import { ensureBootstrap } from "./bootstrap.js";
import { config } from "./config.js";
import { closeDatabase, configureDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import { serveFrontend } from "./node-frontend.js";

if (!config.DATABASE_URL) throw new Error("DATABASE_URL is required.");
configureDatabase(config.DATABASE_URL);
await runMigrations();
await ensureBootstrap();
serveFrontend(app);

const server = serve({
  fetch: app.fetch,
  port: config.PORT,
  hostname: "0.0.0.0",
});

console.log(`Orbit listening on port ${config.PORT}.`);

async function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down.`);
  server.close();
  await closeDatabase();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
