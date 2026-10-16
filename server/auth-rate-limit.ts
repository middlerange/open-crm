import { sql } from "./db.js";
import { hashToken } from "./security.js";

const attemptLimit = 10;
const windowSeconds = 15 * 60;

export async function consumeAuthAttempt(
  kind: "email" | "invite",
  identifier: string,
  database: Pick<typeof sql, "unsafe"> = sql,
) {
  const keyHash = hashToken(`${kind}:${identifier}`);
  await database.unsafe("DELETE FROM auth_rate_limits WHERE expires_at <= now()");
  const [result] = await database.unsafe<{ attempts: number; retryAfter: number }[]>(
    `INSERT INTO auth_rate_limits (key_hash, attempts, expires_at)
     VALUES ($1, 1, now() + $2 * interval '1 second')
     ON CONFLICT (key_hash) DO UPDATE SET
       attempts = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1
         ELSE LEAST(auth_rate_limits.attempts + 1, $3 + 1) END,
       expires_at = CASE WHEN auth_rate_limits.expires_at <= now()
         THEN now() + $2 * interval '1 second' ELSE auth_rate_limits.expires_at END
     RETURNING attempts,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM expires_at - now())))::integer AS "retryAfter"`,
    [keyHash, windowSeconds, attemptLimit],
  );
  return { allowed: result.attempts <= attemptLimit, retryAfter: result.retryAfter };
}
