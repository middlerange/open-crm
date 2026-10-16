import postgres from "postgres";
import { AsyncLocalStorage } from "node:async_hooks";

import { config } from "./config.js";

type SqlClient = ReturnType<typeof postgres>;
const requestDatabase = new AsyncLocalStorage<SqlClient>();

function createClient(connectionString: string) {
  const hostname = new URL(connectionString).hostname.toLowerCase();
  const connectsThroughHyperdrive = hostname === "hyperdrive.local";
  return postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: connectsThroughHyperdrive || config.DATABASE_SSL === "disable" ? false : "require",
    fetch_types: true,
    onnotice: () => undefined,
  });
}

export async function withDatabase<T>(connectionString: string, callback: () => Promise<T>) {
  const requestClient = createClient(connectionString);
  try {
    return await requestDatabase.run(requestClient, callback);
  } finally {
    await requestClient.end({ timeout: 5 });
  }
}

let client: SqlClient | undefined;
let clientConnectionString: string | undefined;

export function configureDatabase(connectionString: string, options: { reuse?: boolean } = {}) {
  if (options.reuse !== false && client && clientConnectionString === connectionString)
    return client;
  client = createClient(connectionString);
  clientConnectionString = connectionString;
  return client;
}

function getClient() {
  const scoped = requestDatabase.getStore();
  if (scoped) return scoped;
  if (!client) {
    if (!config.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
    configureDatabase(config.DATABASE_URL);
  }
  return client!;
}

export const sql = new Proxy((() => undefined) as unknown as SqlClient, {
  apply(_target, thisArg, argumentsList) {
    return Reflect.apply(getClient(), thisArg, argumentsList);
  },
  get(_target, property) {
    const value = Reflect.get(getClient(), property);
    return typeof value === "function" ? value.bind(getClient()) : value;
  },
}) as SqlClient;

export async function closeDatabase() {
  if (client) await client.end({ timeout: 5 });
  client = undefined;
  clientConnectionString = undefined;
}
