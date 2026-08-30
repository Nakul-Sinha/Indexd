export function upstreamSessionCookie(sessionToken: string): string {
  const token = sessionToken.trim();
  if (!token) throw new Error("A validated session token is required.");
  return `better-auth.session_token=${encodeURIComponent(token)}`;
}
