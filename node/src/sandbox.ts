/**
 * The public sandbox key and the documented test values. Bundled here (the SDK has no runtime dependencies); a test
 * keeps these in sync with the API's own copy.
 *
 * The sandbox key is public by design: anyone can use it without signing up. It only answers the magic numbers and
 * e-mail addresses below (anything else returns `403 sandbox_magic_only`), is rate limited per IP, allows jobs of at
 * most 10 rows, has no webhooks and is never billed. For anything more, get a personal test key at
 * https://mobilevalidate.com/get-test-key.
 */
export const SANDBOX_PUBLIC_KEY = "mv_test_publicSandboxn9ZgneuhR1B9CRfKG3fulym";

/** Server-enforced sandbox limits (per client IP; the key is shared by everyone). */
export const SANDBOX_LIMITS = {
  perMinute: 30,
  perDay: 1000,
  maxJobRows: 10,
} as const;

/** Magic test numbers: the same answer for every phone service, with any test key (including the sandbox key). */
export const TEST_NUMBERS = {
  registered: "+447700900001",
  notRegistered: "+447700900002",
  unknown: "+447700900003",
  /** Pending for about 5 s, then registered (exercises the automatic wait). */
  pending: "+447700900004",
  unsupportedCountry: "+447700900005",
  /** Registered; a business account for `whatsapp.business`. */
  business: "+447700900006",
  /** The request fails with `rate_limited`. */
  rateLimited: "+447700900429",
  /** The request fails with `insufficient_balance`. */
  insufficientBalance: "+447700900402",
} as const;

/** Magic test e-mail addresses (domain test.mobilevalidate.com): the same answer for every e-mail service. */
export const TEST_EMAILS = {
  registered: "registered@test.mobilevalidate.com",
  notRegistered: "not-registered@test.mobilevalidate.com",
  unknown: "unknown@test.mobilevalidate.com",
  pending: "pending@test.mobilevalidate.com",
  unsupported: "unsupported@test.mobilevalidate.com",
  rateLimited: "rate-limited@test.mobilevalidate.com",
  insufficientBalance: "no-balance@test.mobilevalidate.com",
} as const;
