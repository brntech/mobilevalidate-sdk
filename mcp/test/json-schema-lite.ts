// Minimal JSON Schema (2020-12) validator for the keywords used by the Server Card schema snapshot and our own
// published schemas: $ref (#/$defs/…), type, required, properties, additionalProperties, items, enum, const, pattern,
// minLength, maxLength, minimum, maximum, minItems, anyOf, oneOf. `format` is ignored. Test-only (no runtime dependency).
type Schema = Record<string, any> | boolean;

export function validate(schema: Schema, value: unknown, root: Record<string, any> = schema as Record<string, any>, path = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: not allowed`];
  const s = schema as Record<string, any>;
  if (s.$ref) {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(s.$ref);
    if (!m) return [`${path}: unsupported $ref ${s.$ref}`];
    return validate(root[m[1]!][m[2]!], value, root, path);
  }
  const errs: string[] = [];
  const t = s.type as string | string[] | undefined;
  if (t) {
    const types = Array.isArray(t) ? t : [t];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
    const ok = types.some((x) => x === actual || (x === "number" && actual === "integer"));
    if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
  }
  if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(value)) errs.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) errs.push(`${path}: not in enum`);
  if (s.anyOf && !s.anyOf.some((x: Schema) => validate(x, value, root, path).length === 0)) errs.push(`${path}: matches no anyOf branch`);
  if (s.oneOf && s.oneOf.filter((x: Schema) => validate(x, value, root, path).length === 0).length !== 1) errs.push(`${path}: must match exactly one oneOf branch`);
  if (typeof value === "string") {
    if (s.pattern && !new RegExp(s.pattern, "u").test(value)) errs.push(`${path}: does not match ${s.pattern}`);
    if (s.minLength != null && [...value].length < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength != null && [...value].length > s.maxLength) errs.push(`${path}: longer than ${s.maxLength}`);
  }
  if (typeof value === "number") {
    if (s.minimum != null && value < s.minimum) errs.push(`${path}: below ${s.minimum}`);
    if (s.maximum != null && value > s.maximum) errs.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(value)) {
    if (s.minItems != null && value.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (s.items) value.forEach((v, i) => errs.push(...validate(s.items, v, root, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) errs.push(`${path}: missing ${r}`);
    const props = s.properties ?? {};
    for (const [k, v] of Object.entries(o)) {
      if (k in props) errs.push(...validate(props[k], v, root, `${path}.${k}`));
      else if (s.additionalProperties !== undefined) errs.push(...validate(s.additionalProperties, v, root, `${path}.${k}`));
    }
  }
  return errs;
}
