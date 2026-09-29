export const DEFAULT_SEED = 1234;

/** Parse a URL seed. Accepts any safe integer (including 0 and negatives); anything else => DEFAULT_SEED. */
export function parseSeed(raw: string | null): number {
  const s = raw?.trim() ?? '';
  if (!/^-?\d+$/.test(s)) return DEFAULT_SEED;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : DEFAULT_SEED;
}
