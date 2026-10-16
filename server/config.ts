import { z } from "zod";

function optionalString(schema: z.ZodString) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const mailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const inboundAliasesSchema = z
  .string()
  .default("{}")
  .transform((value, context) => {
    let input: Record<string, string>;
    try {
      input = z.record(z.string(), z.string()).parse(JSON.parse(value));
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "MAIL_INBOUND_ALIASES must be a JSON object mapping envelope recipients to mailbox addresses.",
      });
      return z.NEVER;
    }

    const aliases: Record<string, string> = {};
    for (const [sourceValue, targetValue] of Object.entries(input)) {
      const source = sourceValue.trim().toLowerCase();
      const target = targetValue.trim().toLowerCase();
      if (!mailAddressPattern.test(source) || !mailAddressPattern.test(target)) {
        context.addIssue({
          code: "custom",
          message: "MAIL_INBOUND_ALIASES keys and values must be complete email addresses.",
        });
        return z.NEVER;
      }
      if (Object.hasOwn(aliases, source)) {
        context.addIssue({
          code: "custom",
          message: `MAIL_INBOUND_ALIASES contains a normalized collision for ${source}.`,
        });
        return z.NEVER;
      }
      aliases[source] = target;
    }

    const chainedSource = Object.keys(aliases).find((source) =>
      Object.hasOwn(aliases, aliases[source]!),
    );
    if (chainedSource) {
      context.addIssue({
        code: "custom",
        message: `MAIL_INBOUND_ALIASES must map directly to a mailbox; ${chainedSource} points to another configured alias.`,
      });
      return z.NEVER;
    }
    return aliases;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    CONTENT_RESEARCH_ENABLED: z.enum(["true", "false"]).default("false"),
    PORT: z.coerce.number().int().positive().default(8787),
    APP_ORIGIN: z.string().url().default("http://localhost:5173"),
    DATABASE_URL: optionalString(z.string().min(1)),
    DATABASE_SSL: z.enum(["require", "disable"]).default("require"),
    USERORBIT_ACCOUNT_ID: optionalString(z.string().min(1)),
    USERORBIT_API_HOST: z
      .string()
      .url()
      .refine((value) => new URL(value).protocol === "https:", "USERORBIT_API_HOST must use HTTPS")
      .default("https://api.userorbit.com"),
    SESSION_COOKIE_NAME: z.string().min(1).default("orbit_session"),
    BOOTSTRAP_EMAIL: optionalString(z.string().email()),
    BOOTSTRAP_PASSWORD: optionalString(z.string().min(12)),
    BOOTSTRAP_NAME: optionalString(z.string().min(1)),
    AGENT_API_TOKEN: optionalString(z.string().min(24)),
    MAIL_DOMAINS: z.string().default(""),
    MAIL_DOMAIN_WORKSPACES: z
      .string()
      .default("{}")
      .transform((value, context) => {
        try {
          return z.record(z.string(), z.string().min(1)).parse(JSON.parse(value));
        } catch {
          context.addIssue({
            code: "custom",
            message:
              "MAIL_DOMAIN_WORKSPACES must be a JSON object mapping email domains to workspace slugs.",
          });
          return z.NEVER;
        }
      }),
    MAIL_INBOUND_ALIASES: inboundAliasesSchema,
    MAIL_SENDING_ENABLED: z.enum(["true", "false"]).default("false"),
    CLOUDFLARE_EMAIL_ACCOUNT_ID: optionalString(z.string().regex(/^[a-f0-9]{32}$/i)),
    CLOUDFLARE_EMAIL_API_TOKEN: optionalString(z.string().min(1)),
    MAIL_INGRESS_SECRET: optionalString(z.string().min(32)),
  })
  .superRefine((environment, context) => {
    const mailboxDomains = new Set(
      environment.MAIL_DOMAINS.split(",")
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean),
    );
    const aliasSourceDomains = new Set<string>();
    for (const [source, target] of Object.entries(environment.MAIL_INBOUND_ALIASES)) {
      const sourceDomain = source.split("@")[1]!;
      const targetDomain = target.split("@")[1]!;
      aliasSourceDomains.add(sourceDomain);
      if (!mailboxDomains.has(targetDomain)) {
        context.addIssue({
          code: "custom",
          path: ["MAIL_INBOUND_ALIASES"],
          message: `Inbound alias ${source} targets ${targetDomain}, which is not listed in MAIL_DOMAINS.`,
        });
      } else if (!environment.MAIL_DOMAIN_WORKSPACES[targetDomain]) {
        context.addIssue({
          code: "custom",
          path: ["MAIL_INBOUND_ALIASES"],
          message: `Inbound alias ${source} targets ${targetDomain}, which is not assigned in MAIL_DOMAIN_WORKSPACES.`,
        });
      }
    }
    for (const sourceDomain of aliasSourceDomains) {
      if (mailboxDomains.has(sourceDomain)) {
        context.addIssue({
          code: "custom",
          path: ["MAIL_INBOUND_ALIASES"],
          message: `Inbound alias source domain ${sourceDomain} cannot also be a direct mailbox domain.`,
        });
      }
    }
  });

type RuntimeEnvironment = Record<string, unknown>;

function nodeEnvironment(): RuntimeEnvironment {
  return typeof process === "undefined" ? {} : process.env;
}

export let config = envSchema.parse(nodeEnvironment());
export let isProduction = config.NODE_ENV === "production";

export function configureRuntime(environment: RuntimeEnvironment) {
  config = envSchema.parse(environment);
  isProduction = config.NODE_ENV === "production";
  return config;
}
