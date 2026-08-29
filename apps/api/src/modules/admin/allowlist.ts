const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function isAdminEmail(email: string): boolean {
  const configuredEmails = process.env.ADMIN_EMAIL_ALLOWLIST;
  if (!configuredEmails) return false;

  const allowlist = new Set(configuredEmails.split(",").map(normalizeEmail).filter(Boolean));

  return allowlist.has(normalizeEmail(email));
}
