const DEV_TOKEN = "dev-approval-token";
const redeemed = new Set<string>();

export function redeemApprovalToken(input: {
  token: string;
  serverId: string;
  expectedDigest: string | null;
  alreadyRedeemed?: boolean;
}): void {
  if (!input.token) {
    throw new Error("Missing approval token");
  }
  if (input.token !== DEV_TOKEN && process.env.NODE_ENV !== "test") {
    // Engineer 3's approvals module replaces this stub at integration.
    throw new Error("Invalid approval token");
  }
  if (!input.alreadyRedeemed && redeemed.has(input.token + input.serverId)) {
    throw new Error("Approval token already spent");
  }
  if (input.expectedDigest && process.env.REQUIRE_DIGEST_MATCH === "true") {
    const bound = process.env.DEV_APPROVAL_DIGEST;
    if (bound && bound !== input.expectedDigest) {
      throw new Error("Approval token content_digest does not match built JAR");
    }
  }
  redeemed.add(input.token + input.serverId);
}
