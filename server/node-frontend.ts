import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";

import type { AppEnv } from "./types.js";

export function serveFrontend(app: Hono<AppEnv>, root = "./dist") {
  const files = serveStatic({ root });
  const index = serveStatic({ root, path: "index.html" });
  app.get("*", async (context, next) => {
    if (context.req.path === "/api" || context.req.path.startsWith("/api/")) return next();
    return files(context, async () => {
      if (context.req.header("accept")?.includes("text/html")) {
        const response = await index(context, next);
        if (response) context.res = response;
        return;
      }
      return next();
    });
  });
}
