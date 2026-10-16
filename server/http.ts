import type { Context } from "hono";
import type { ZodType } from "zod";

export async function parseJson<T>(context: Context, schema: ZodType<T>) {
  let body: unknown;
  try {
    body = await context.req.json();
  } catch {
    return { ok: false as const, response: context.json({ error: "Invalid JSON body." }, 400) };
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false as const,
      response: context.json(
        {
          error: "Validation failed.",
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        422,
      ),
    };
  }
  return { ok: true as const, data: result.data };
}

export function databaseClientError(context: Context, error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "23505") {
    return context.json(
      { error: "A record with the same company domain, email, or LinkedIn URL already exists." },
      409,
    );
  }
  if (code === "22P02") {
    return context.json({ error: "The request contains an invalid identifier." }, 400);
  }
  return null;
}

export function databaseError(context: Context, error: unknown) {
  const clientError = databaseClientError(context, error);
  if (clientError) return clientError;
  console.error("Database operation failed:", error instanceof Error ? error.message : error);
  return context.json({ error: "The request could not be completed." }, 500);
}
