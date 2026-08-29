import { afterAll, beforeEach, expect, mock, test } from "bun:test";

type SessionRecord = {
  userId: string;
  expiresAt: Date;
};

type UserRecord = {
  email: string;
  emailVerified: boolean;
};

let sessionRecord: SessionRecord | null;
let userRecord: UserRecord | null;

mock.module("../src/db", () => ({
  db: {
    query: {
      sessions: {
        findFirst: async () => sessionRecord,
      },
      users: {
        findFirst: async () => userRecord,
      },
    },
  },
}));

const { AuthService } = await import("../src/modules/auth/service");
const { adminModule } = await import("../src/modules/admin");
const originalAdminEmailAllowlist = process.env.ADMIN_EMAIL_ALLOWLIST;

beforeEach(() => {
  process.env.ADMIN_EMAIL_ALLOWLIST = "admin@example.com";
  sessionRecord = {
    userId: "admin-user-id",
    expiresAt: new Date(Date.now() + 60_000),
  };
  userRecord = {
    email: "admin@example.com",
    emailVerified: true,
  };
});

afterAll(() => {
  if (originalAdminEmailAllowlist === undefined) {
    delete process.env.ADMIN_EMAIL_ALLOWLIST;
  } else {
    process.env.ADMIN_EMAIL_ALLOWLIST = originalAdminEmailAllowlist;
  }
});

test("admin auth rejects requests without a valid session", async () => {
  sessionRecord = null;

  expect(AuthService.requireAdminUserId("better-auth.session_token=invalid")).rejects.toMatchObject(
    { code: 401 },
  );
});

test("admin auth rejects an unverified allowlisted email", async () => {
  userRecord = {
    email: "admin@example.com",
    emailVerified: false,
  };

  expect(AuthService.requireAdminUserId("better-auth.session_token=valid")).rejects.toMatchObject({
    code: 403,
  });
});

test("admin auth rejects a verified email outside the allowlist", async () => {
  userRecord = {
    email: "not-an-admin@example.com",
    emailVerified: true,
  };

  expect(AuthService.requireAdminUserId("better-auth.session_token=valid")).rejects.toMatchObject({
    code: 403,
  });
});

test("admin auth fails closed when the allowlist is not configured", async () => {
  delete process.env.ADMIN_EMAIL_ALLOWLIST;

  expect(AuthService.requireAdminUserId("better-auth.session_token=valid")).rejects.toMatchObject({
    code: 403,
  });
});

test("admin auth accepts the allowlisted verified email case-insensitively", async () => {
  userRecord = {
    email: "  ADMIN@EXAMPLE.COM  ",
    emailVerified: true,
  };

  await expect(AuthService.requireAdminUserId("better-auth.session_token=valid")).resolves.toBe(
    "admin-user-id",
  );
});

test("admin authorization check is exposed at the documented path", async () => {
  const response = await adminModule.handle(
    new Request("http://localhost/api/admin/authorization-check", {
      headers: {
        cookie: "better-auth.session_token=valid",
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
});
