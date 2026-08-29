import { createHash } from "node:crypto";

/**
 * RFC 8785 JSON Canonicalization Scheme, plus the content digest built on it.
 *
 * Why this exists, from STACK.md section 12: the digest is computed by
 * buildRuleJar() in one process and recomputed by the deployment controller in
 * another, possibly on a different runtime. If the two serializations differ in
 * key order, unicode escaping, or number formatting, the digests differ and a
 * legitimate deployment is refused. That failure presents as "approvals randomly
 * stop working" and costs a day to find.
 *
 * Both sides call canonicalize() from here. Neither side calls JSON.stringify.
 */

export class CanonicalizationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} (at ${path || "<root>"})`);
    this.name = "CanonicalizationError";
  }
}

/**
 * Serialize a number the way ECMAScript Number::toString does, which is what
 * RFC 8785 section 3.2.2.3 requires. JSON.stringify already does exactly this
 * for finite numbers, so 1.0 becomes "1" and 1e21 becomes "1e+21".
 */
function canonicalNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalizationError(`Non-finite number ${value} is not valid JSON`, path);
  }
  // Normalize negative zero, which JSON.stringify renders as "0" already but
  // which we make explicit so the intent is not mistaken for an accident.
  if (Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

/**
 * RFC 8785 requires the shortest escape sequence for the characters JSON must
 * escape and literal UTF-8 for everything else. JSON.stringify on a string does
 * precisely that, including the well-formed surrogate escaping added in ES2019.
 */
function canonicalString(value: string): string {
  return JSON.stringify(value);
}

function canonicalValue(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return canonicalNumber(value, path);
    case "string":
      return canonicalString(value);
    case "undefined":
      throw new CanonicalizationError(
        "undefined has no JSON representation; omit the key or use null",
        path,
      );
    case "bigint":
      throw new CanonicalizationError("bigint has no JSON representation", path);
    case "function":
    case "symbol":
      throw new CanonicalizationError(`${typeof value} has no JSON representation`, path);
  }

  if (Array.isArray(value)) {
    const parts = value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
    return `[${parts.join(",")}]`;
  }

  if (value instanceof Date) {
    throw new CanonicalizationError(
      "Date is not a JSON value; serialize to an ISO-8601 string first",
      path,
    );
  }

  // RFC 8785 sorts object keys by UTF-16 code unit. Array.prototype.sort on
  // strings compares by code unit already, so the default comparator is correct
  // and a locale-aware comparator would not be.
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => {
    const child = canonicalValue(record[key], path ? `${path}.${key}` : key);
    return `${canonicalString(key)}:${child}`;
  });
  return `{${parts.join(",")}}`;
}

/** Canonical JSON text for a value, per RFC 8785. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value, "");
}

/**
 * The content digest an approval token binds to. Always prefixed with the
 * algorithm so a future migration is visible rather than silent.
 */
export function contentDigest(value: unknown): string {
  const canonical = canonicalize(value);
  const hash = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `sha256:${hash}`;
}

/**
 * Constant-time comparison for digests and token hashes. Digest comparison is
 * not strictly a secret comparison, but token hash comparison is, and having one
 * helper removes the chance of the wrong one being used at the wrong callsite.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
