import type { CurrentUser } from "./auth";

export function crmEditPayload(
  entityType: "account" | "contact" | "opportunity",
  role: CurrentUser["role"] | undefined,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const payload = { ...fields };
  if (role !== "founder" && role !== "manager") {
    delete payload.ownerId;
    if (entityType === "account") delete payload.status;
  }
  return payload;
}
