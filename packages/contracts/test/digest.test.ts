import { describe, expect, test } from "bun:test";
import { CanonicalizationError, canonicalize, contentDigest, digestsEqual } from "../src/digest.ts";

describe("canonicalize", () => {
  test("sorts object keys by UTF-16 code unit", () => {
    expect(canonicalize({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  test("is independent of insertion order, which is the whole point", () => {
    const one = { schema_version: 1, rules: [{ id: "a", rule: "gamerule" }] };
    const other = { rules: [{ rule: "gamerule", id: "a" }], schema_version: 1 };
    expect(canonicalize(one)).toBe(canonicalize(other));
    expect(contentDigest(one)).toBe(contentDigest(other));
  });

  test("preserves array order, which is significant", () => {
    expect(canonicalize([1, 2, 3])).toBe("[1,2,3]");
    expect(canonicalize([3, 2, 1])).not.toBe(canonicalize([1, 2, 3]));
  });

  test("normalizes numbers the way ECMAScript does", () => {
    expect(canonicalize({ n: 1.0 })).toBe('{"n":1}');
    expect(canonicalize({ n: -0 })).toBe('{"n":0}');
    expect(canonicalize({ n: 1e21 })).toBe('{"n":1e+21}');
    expect(canonicalize({ n: 0.1 })).toBe('{"n":0.1}');
  });

  test("emits literal UTF-8 for non-ASCII rather than escaping it", () => {
    expect(canonicalize({ mob: "crééper" })).toBe('{"mob":"crééper"}');
  });

  test("escapes control characters using the short forms", () => {
    expect(canonicalize({ s: "a\nb\tc" })).toBe('{"s":"a\\nb\\tc"}');
  });

  test("handles nesting", () => {
    const value = { z: [{ b: 1, a: [true, null] }], a: "x" };
    expect(canonicalize(value)).toBe('{"a":"x","z":[{"a":[true,null],"b":1}]}');
  });

  test("rejects values with no JSON representation", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ u: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalize({ d: new Date() })).toThrow(CanonicalizationError);
  });

  test("names the path in the error so a bad document is findable", () => {
    try {
      canonicalize({ rules: [{ ok: 1 }, { bad: Number.NaN }] });
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as CanonicalizationError).path).toBe("rules[1].bad");
    }
  });

  test("does not silently drop an undefined key, which would change meaning", () => {
    // JSON.stringify would produce {} here and hash a different document than
    // the one the caller passed. That is the failure this rejection prevents.
    expect(JSON.stringify({ region: undefined })).toBe("{}");
    expect(() => canonicalize({ region: undefined })).toThrow(CanonicalizationError);
  });
});

describe("contentDigest", () => {
  test("is prefixed with the algorithm", () => {
    expect(contentDigest({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("is stable across reserializations of the same document", () => {
    const document = { schema_version: 1, rules: [{ id: "r", rule: "gamerule", value: 1.0 }] };
    const roundTripped = JSON.parse(JSON.stringify(document));
    expect(contentDigest(roundTripped)).toBe(contentDigest(document));
  });

  test("changes when any value changes", () => {
    expect(contentDigest({ multiplier: 1.4 })).not.toBe(contentDigest({ multiplier: 1.5 }));
  });

  test("known vector, so a refactor cannot silently change every digest", () => {
    // Canonical form is {"a":1,"b":[true,null],"c":"x"}
    expect(contentDigest({ c: "x", a: 1, b: [true, null] })).toBe(
      `sha256:${Bun.SHA256.hash('{"a":1,"b":[true,null],"c":"x"}', "hex")}`,
    );
  });
});

describe("digestsEqual", () => {
  test("matches identical digests and rejects different ones", () => {
    const a = contentDigest({ x: 1 });
    expect(digestsEqual(a, a)).toBe(true);
    expect(digestsEqual(a, contentDigest({ x: 2 }))).toBe(false);
  });

  test("rejects a length mismatch without throwing", () => {
    expect(digestsEqual("sha256:abc", "sha256:abcd")).toBe(false);
  });
});
