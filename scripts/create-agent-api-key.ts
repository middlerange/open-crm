import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { closeDatabase, sql } from "../server/db.js";
import { createOpaqueToken, hashToken } from "../server/security.js";

type Options = {
  workspace?: string;
  user?: string;
  name: string;
  scopes: string[];
  apiUrl: string;
  output: string;
};

function argumentValue(args: string[], name: string) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseOptions(): Options {
  const args = process.argv.slice(2);
  const scopes = (argumentValue(args, "--scopes") ?? "read,write")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.some((scope) => !["read", "write"].includes(scope))) {
    throw new Error("Scopes must be a comma-separated subset of read,write.");
  }
  return {
    workspace: argumentValue(args, "--workspace"),
    user: argumentValue(args, "--user"),
    name: argumentValue(args, "--name") ?? "Codex Orbit skill",
    scopes,
    apiUrl:
      argumentValue(args, "--api-url") ??
      (process.env.NODE_ENV === "production"
        ? (process.env.APP_ORIGIN ?? "http://localhost:8787")
        : `http://localhost:${process.env.PORT ?? "8787"}`),
    output: path.resolve(argumentValue(args, "--output") ?? ".env.local"),
  };
}

function updateEnvironmentFile(current: string, values: Record<string, string>) {
  const lines = current ? current.replace(/\n$/, "").split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    const next = `${key}=${value}`;
    if (index === -1) lines.push(next);
    else lines[index] = next;
  }
  return `${lines.join("\n")}\n`;
}

async function selectWorkspace(selector?: string) {
  if (selector) {
    const [workspace] = await sql<{ id: string; name: string; slug: string }[]>`
      SELECT id, name, slug FROM workspaces
      WHERE id::text = ${selector} OR slug = ${selector}
      LIMIT 1
    `;
    if (!workspace) throw new Error(`Workspace "${selector}" was not found.`);
    return workspace;
  }

  const workspaces = await sql<{ id: string; name: string; slug: string }[]>`
    SELECT id, name, slug FROM workspaces ORDER BY created_at LIMIT 2
  `;
  if (workspaces.length !== 1) {
    throw new Error(
      "Pass --workspace <slug-or-id> when the database has zero or multiple workspaces.",
    );
  }
  return workspaces[0]!;
}

async function selectUser(workspaceId: string, selector?: string) {
  if (selector) {
    const [user] = await sql<{ id: string; name: string; email: string }[]>`
      SELECT u.id, u.name, u.email
      FROM users u JOIN memberships m ON m.user_id = u.id
      WHERE m.workspace_id = ${workspaceId} AND u.active = true
        AND (u.id::text = ${selector} OR lower(u.email) = lower(${selector}))
      LIMIT 1
    `;
    if (!user) throw new Error(`Active workspace user "${selector}" was not found.`);
    return user;
  }

  const users = await sql<{ id: string; name: string; email: string }[]>`
    SELECT u.id, u.name, u.email
    FROM users u JOIN memberships m ON m.user_id = u.id
    WHERE m.workspace_id = ${workspaceId} AND u.active = true
    ORDER BY m.joined_at LIMIT 2
  `;
  if (users.length !== 1) {
    throw new Error("Pass --user <email-or-id> when the workspace has multiple active users.");
  }
  return users[0]!;
}

async function main() {
  const options = parseOptions();
  const workspace = await selectWorkspace(options.workspace);
  const user = await selectUser(workspace.id, options.user);
  const token = `orbit_${createOpaqueToken(32)}`;
  const tokenHint = `${token.slice(0, 12)}…${token.slice(-4)}`;
  await sql`
    INSERT INTO agent_tokens (workspace_id, name, token_hash, token_hint, scopes, created_by)
    VALUES (
      ${workspace.id}, ${options.name}, ${hashToken(token)}, ${tokenHint}, ${options.scopes},
      ${user.id}
    )
  `;

  let current = "";
  try {
    current = await readFile(options.output, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await writeFile(
    options.output,
    updateEnvironmentFile(current, {
      ORBIT_API_URL: options.apiUrl.replace(/\/$/, ""),
      ORBIT_API_KEY: token,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(options.output, 0o600);
  console.log(
    `Created "${options.name}" for ${user.name} in ${workspace.name} (${workspace.slug}).`,
  );
  console.log(`Stored the key in ${options.output}; the database stores only its SHA-256 hash.`);
}

main()
  .catch((error) => {
    console.error("Agent key provisioning failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closeDatabase);
