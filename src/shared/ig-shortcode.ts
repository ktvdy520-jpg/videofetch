/**
 * Instagram shortcode → media pk (same base64 alphabet decode used by common downloaders).
 */
const IG_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function shortcodeToMediaId(raw: string): string {
  const asNum = Number(raw);
  if (Number.isInteger(asNum) && String(asNum) === raw) return raw;

  let code = raw;
  // Some clients append a long suffix; strip if present (4saved / Qooly-style).
  if (code.length > 28) code = code.slice(0, code.length - 28);

  let id = 0n;
  for (const ch of code) {
    const idx = IG_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    id *= 64n;
    id += BigInt(idx);
  }
  return id.toString();
}

/** Default web app id; overridden when we see a real request header. */
export const DEFAULT_IG_APP_ID = '936619743392459';
