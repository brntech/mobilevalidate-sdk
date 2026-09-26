import { describe, expect, it } from "vitest";
import { normalizeNumbers, normalizeOne, maskPhone } from "../src/normalize.ts";
import { checkAgentKey, fromMicro, toMicro } from "../src/util.ts";

describe("checkAgentKey", () => {
  it("accepts agent and test keys", () => {
    expect(checkAgentKey("mv_agent_abc123").ok).toBe(true);
    expect(checkAgentKey("mv_test_abc123").ok).toBe(true);
  });
  it("rejects live keys with a clear message, and missing/garbage keys", () => {
    const live = checkAgentKey("mv_live_abc123");
    expect(live.ok).toBe(false);
    expect(!live.ok && live.message).toMatch(/Live keys .* not accepted/);
    expect(!live.ok && live.message).not.toContain("abc123");
    expect(checkAgentKey(undefined).ok).toBe(false);
    expect(checkAgentKey("sk_foo").ok).toBe(false);
  });
});

describe("normalize", () => {
  it("handles international, 00 prefix, trunk prefixes and dial-code-without-plus", () => {
    expect(normalizeOne("+44 (0)7700-900001").e164).toBe("+447700900001");
    expect(normalizeOne("0044 7700 900001").e164).toBe("+447700900001");
    expect(normalizeOne("07700 900001", "GB").e164).toBe("+447700900001");
    expect(normalizeOne("447700900001", "GB")).toMatchObject({ e164: "+447700900001", note: expect.stringMatching(/already/) });
    expect(normalizeOne("(202) 555-0143", "US").e164).toBe("+12025550143");
    expect(normalizeOne("1 202 555 0143", "US").e164).toBe("+12025550143");
    expect(normalizeOne("+1 202 555 0143").country).toBe(null); // +1 is shared by several countries
    expect(normalizeOne("+33 6 12 34 56 78").country).toBe("FR");
    expect(normalizeOne("12345", "GB").status).toBe("invalid");
    expect(normalizeOne("0612345678", "ZZ").status).toBe("ambiguous");
  });
  it("marks duplicates after normalization", () => {
    const r = normalizeNumbers(["+447700900001", "07700 900001"], "GB");
    expect(r.results.map((x) => x.status)).toEqual(["valid", "duplicate"]);
    expect(r.summary).toMatchObject({ valid: 1, duplicate: 1 });
  });
  it("masks numbers", () => {
    expect(maskPhone("+447700900001")).toBe("+44770*****01");
  });
});

describe("money", () => {
  it("round-trips decimals without floats", () => {
    expect(toMicro("1.00")).toBe(1_000_000n);
    expect(toMicro("0.0024")).toBe(2_400n);
    expect(fromMicro(3_200_000n)).toBe("3.2");
    expect(fromMicro(0n)).toBe("0");
  });
});
