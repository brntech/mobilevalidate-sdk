import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generatedSource, readmeTable, withReadmeTable } from "../scripts/gen-services.ts";
import { SERVICE_ALIASES, SERVICE_CATALOG, type CheckInput } from "../src/index.ts";

describe("generated service catalog", () => {
  it("src/services.generated.ts matches the public catalog (run gen:services if this fails)", () => {
    expect(readFileSync(new URL("../src/services.generated.ts", import.meta.url), "utf8")).toBe(generatedSource());
  });
  it("README services table matches the catalog", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(withReadmeTable(readme)).toBe(readme);
    expect(readmeTable()).toContain("`telegram.registered`");
  });
  it("advertises wave-1 phone services and wave-2 e-mail services (with their input type)", () => {
    const codes = SERVICE_CATALOG.map((s) => s.code as string);
    expect(codes).toContain("whatsapp.registered");
    expect(codes).toContain("network.carrier");
    expect(codes).toContain("email.valid");
    expect(codes).toContain("gmail.email");
    expect(codes).not.toContain("paypal.email"); // wave 3
    expect(codes.some((c) => c.endsWith(".activity"))).toBe(false);
    expect(SERVICE_CATALOG.find((s) => s.code === "gmail.email")).toMatchObject({ inputType: "email", realtime: false });
    expect(SERVICE_CATALOG.find((s) => s.code === "telegram.registered")).toMatchObject({ inputType: "phone" });
  });
  it("advertises number.spam (alias spam, US/CA/DE) but not number.hlr (coming soon)", () => {
    const codes = SERVICE_CATALOG.map((s) => s.code as string);
    expect(SERVICE_CATALOG.find((s) => s.code === "number.spam")).toMatchObject({ resultKind: "attributes", realtime: true,
      countries: ["US", "CA", "DE"], attributes: expect.arrayContaining(["risk_level", "risk_score", "sources"]) });
    expect(SERVICE_ALIASES.spam).toBe("number.spam");
    expect(codes).not.toContain("number.hlr");
    expect(Object.keys(SERVICE_ALIASES)).not.toContain("hlr");
    const spam: CheckInput = "spam"; // typed alias
    expect(spam).toBe("spam");
  });
});
