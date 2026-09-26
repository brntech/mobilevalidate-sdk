/**
 * Local, free, format-level E.164 normalization (no numbering-plan database, no network).
 * It is deliberately conservative: anything it cannot place with confidence is returned as "ambiguous"
 * with a hint; the API performs full validation when numbers are actually checked.
 */

/** Dial code + national trunk prefix for common countries (trunk prefix is stripped from national formats). */
const COUNTRIES: Record<string, { cc: string; trunk?: string }> = {
  GB: { cc: "44", trunk: "0" }, IE: { cc: "353", trunk: "0" }, US: { cc: "1", trunk: "1" }, CA: { cc: "1", trunk: "1" },
  DE: { cc: "49", trunk: "0" }, FR: { cc: "33", trunk: "0" }, ES: { cc: "34" }, IT: { cc: "39" }, PT: { cc: "351" },
  NL: { cc: "31", trunk: "0" }, BE: { cc: "32", trunk: "0" }, CH: { cc: "41", trunk: "0" }, AT: { cc: "43", trunk: "0" },
  PL: { cc: "48" }, SE: { cc: "46", trunk: "0" }, TR: { cc: "90", trunk: "0" }, UA: { cc: "380", trunk: "0" },
  IN: { cc: "91", trunk: "0" }, PK: { cc: "92", trunk: "0" }, ID: { cc: "62", trunk: "0" }, PH: { cc: "63", trunk: "0" },
  MY: { cc: "60", trunk: "0" }, SG: { cc: "65" }, HK: { cc: "852" }, AU: { cc: "61", trunk: "0" }, NZ: { cc: "64", trunk: "0" },
  BR: { cc: "55", trunk: "0" }, MX: { cc: "52" }, AR: { cc: "54", trunk: "0" }, CO: { cc: "57" },
  ZA: { cc: "27", trunk: "0" }, NG: { cc: "234", trunk: "0" }, KE: { cc: "254", trunk: "0" }, EG: { cc: "20", trunk: "0" },
  AE: { cc: "971", trunk: "0" }, SA: { cc: "966", trunk: "0" }, IL: { cc: "972", trunk: "0" },
};

/** Reverse map dial code → country for display; shared codes (+1) resolve to null (ambiguous region). */
const BY_CC = new Map<string, string | null>();
for (const [iso, { cc }] of Object.entries(COUNTRIES)) BY_CC.set(cc, BY_CC.has(cc) ? null : iso);

export const SUPPORTED_DEFAULT_COUNTRIES = Object.keys(COUNTRIES);

export type NormalizeStatus = "valid" | "invalid" | "ambiguous" | "duplicate";

export interface NormalizedNumber {
  input: string;
  e164: string | null;
  country: string | null;
  status: NormalizeStatus;
  note: string | null;
}

function countryOf(digits: string): string | null {
  for (const len of [3, 2, 1]) {
    const hit = BY_CC.get(digits.slice(0, len));
    if (hit !== undefined) return hit;
  }
  return null;
}

function checkLength(digits: string, input: string): NormalizedNumber | null {
  if (digits.length < 8) return { input, e164: null, country: null, status: "invalid", note: "Too short for an international number." };
  if (digits.length > 15) return { input, e164: null, country: null, status: "invalid", note: "Longer than 15 digits (E.164 maximum)." };
  return null;
}

export function normalizeOne(input: string, defaultCountry?: string): NormalizedNumber {
  const raw = input.trim().replace(/^tel:/i, "");
  if (!raw) return { input, e164: null, country: null, status: "invalid", note: "Empty value." };
  if (/[^\d\s()+.\-/]/.test(raw) || raw.lastIndexOf("+") > 0) {
    return { input, e164: null, country: null, status: "invalid", note: "Contains characters that are not part of a phone number." };
  }
  // "+44 (0)7700 …": the bracketed trunk zero is a common display convention and is dropped.
  const noTrunk = /^(\+|00)/.test(raw) ? raw.replace(/\(\s*0\s*\)/g, "") : raw;
  let s = noTrunk.replace(/[\s().\-/]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);

  if (s.startsWith("+")) {
    const digits = s.slice(1);
    const bad = checkLength(digits, input);
    if (bad) return bad;
    if (digits.startsWith("0")) return { input, e164: null, country: null, status: "invalid", note: "Country codes never start with 0." };
    return { input, e164: "+" + digits, country: countryOf(digits), status: "valid", note: null };
  }

  if (defaultCountry) {
    const c = COUNTRIES[defaultCountry.toUpperCase()];
    if (!c) {
      return {
        input, e164: null, country: null, status: "ambiguous",
        note: `default_country ${defaultCountry} is not in the local table; send the number in +<country code> format or let the check call normalize it.`,
      };
    }
    let national = s;
    let note: string | null = null;
    if (national.startsWith(c.cc) && national.length - c.cc.length >= 9) {
      // e.g. "447700900001" with GB: the dial code is already present (just the "+" is missing).
      national = national.slice(c.cc.length);
      note = `Read as already including country code +${c.cc}.`;
    } else if (c.trunk && national.startsWith(c.trunk)) {
      national = national.slice(c.trunk.length);
    }
    const digits = c.cc + national;
    const bad = checkLength(digits, input);
    if (bad) return bad;
    return { input, e164: "+" + digits, country: defaultCountry.toUpperCase(), status: "valid", note };
  }

  return {
    input, e164: null, country: null, status: "ambiguous",
    note: "No country: add the +<country code> prefix (e.g. +447700900001) or pass default_country (e.g. \"GB\").",
  };
}

export function normalizeNumbers(numbers: string[], defaultCountry?: string) {
  const seen = new Set<string>();
  const results = numbers.map((n) => {
    const r = normalizeOne(n, defaultCountry);
    if (r.e164 && seen.has(r.e164)) return { ...r, status: "duplicate" as const, note: "Same number appears earlier in the list." };
    if (r.e164) seen.add(r.e164);
    return r;
  });
  const count = (s: NormalizeStatus) => results.filter((r) => r.status === s).length;
  return {
    results,
    summary: { total: results.length, valid: count("valid"), invalid: count("invalid"), ambiguous: count("ambiguous"), duplicate: count("duplicate") },
  };
}

/** Mask a phone number for logs: keep the first 6 and last 2 characters. */
export function maskPhone(v: string): string {
  if (v.length <= 6) return "***";
  return v.slice(0, 6) + "*".repeat(Math.max(0, v.length - 8)) + v.slice(-2);
}
