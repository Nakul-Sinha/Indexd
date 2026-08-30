import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";

import { accounts, sessions, userQuotas, users, verifications } from "./auth-schema";
import { getDb } from "./db";

function requiredEnv(name: "BETTER_AUTH_SECRET" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET") {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for Indexd authentication.`);
  return value;
}

const baseURL =
  process.env.BETTER_AUTH_URL?.trim() ||
  (process.env.NODE_ENV === "production" ? "https://www.indexd.app" : "http://localhost:3000");

const configuredOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const trustedOrigins = new Set([
  baseURL,
  ...(process.env.NODE_ENV === "production"
    ? ["https://www.indexd.app", "https://indexd.app"]
    : ["http://localhost:3000", "http://127.0.0.1:3000"]),
  ...configuredOrigins,
]);

function createAuth() {
  const db = getDb();

  return betterAuth({
    baseURL,
    trustedOrigins: [...trustedOrigins],
    secret: requiredEnv("BETTER_AUTH_SECRET"),
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
      },
    }),
    databaseHooks: {
      session: {
        create: {
          async after(session) {
            await db.insert(userQuotas).values({ userId: session.userId }).onConflictDoNothing();
          },
        },
      },
    },
    socialProviders: {
      google: {
        clientId: requiredEnv("GOOGLE_CLIENT_ID"),
        clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
      },
    },
  });
}

type IndexdAuth = ReturnType<typeof createAuth>;

let configuredAuth: IndexdAuth | undefined;

/**
 * Auth and database construction stay behind this runtime accessor so Next can
 * compile route modules without production secrets while requests fail closed.
 */
export function getAuth(): IndexdAuth {
  if (!configuredAuth) {
    configuredAuth = createAuth();
  }
  return configuredAuth;
}

export function authenticationUnavailable(error: unknown): Response {
  console.error("Indexd authentication is unavailable", {
    message: error instanceof Error ? error.message : "Unknown authentication error",
  });
  return Response.json(
    {
      error: "authentication_unavailable",
      message: "Authentication is temporarily unavailable.",
    },
    {
      status: 503,
      headers: { "cache-control": "private, no-store" },
    },
  );
}

export async function getSession(headers: Headers) {
  try {
    return { session: await getAuth().api.getSession({ headers }) };
  } catch (error) {
    return { response: authenticationUnavailable(error) };
  }
}

export type AuthSession = IndexdAuth["$Infer"]["Session"];
