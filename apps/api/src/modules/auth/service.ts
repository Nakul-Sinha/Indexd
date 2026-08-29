import { sessions } from "@repo/db";
import { eq } from "drizzle-orm";
import { status } from "elysia";

import { db } from "../../db";
import { isAdminEmail } from "../admin/allowlist";

const SESSION_COOKIE_NAMES = [
  "session_token",
  "better-auth.session_token",
  "__Secure-better-auth.session_token",
] as const;

export abstract class AuthService {
  // Better Auth stores only the token portion of its signed cookie in sessions.
  static getSessionToken(cookieHeader: string): string | null {
    const cookies = new Map(
      cookieHeader.split(";").map((part) => {
        const [name, ...valueParts] = part.trim().split("=");
        return [name, valueParts.join("=")] as const;
      }),
    );

    for (const cookieName of SESSION_COOKIE_NAMES) {
      const signedToken = cookies.get(cookieName);
      if (!signedToken) continue;

      try {
        return decodeURIComponent(signedToken).split(".")[0] || null;
      } catch {
        return null;
      }
    }

    return null;
  }

  static async getValidSession(cookieHeader: string) {
    const token = AuthService.getSessionToken(cookieHeader);
    if (!token) return null;

    const session = await db.query.sessions.findFirst({
      where: eq(sessions.token, token),
    });

    if (!session || session.expiresAt <= new Date()) return null;
    return session;
  }

  static async requireUserId(cookieHeader: string): Promise<string> {
    const session = await AuthService.getValidSession(cookieHeader);
    if (!session) throw status(401, "Authentication required");
    return session.userId;
  }

  static async requireAdminUserId(cookieHeader: string): Promise<string> {
    const session = await AuthService.getValidSession(cookieHeader);
    if (!session) throw status(401, "Authentication required");

    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.id, session.userId),
      columns: {
        email: true,
        emailVerified: true,
      },
    });

    if (!user?.emailVerified || !user.email || !isAdminEmail(user.email)) {
      throw status(403, "Forbidden");
    }

    return session.userId;
  }
}
