/** Text decoding with BOM handling and a Windows-1252 fallback (never throws on bad bytes). */
export interface Decoded { text: string; encoding: string }

export function decodeText(bytes: Uint8Array): Decoded {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  // UTF-16 without a BOM: every other byte is NUL in mostly-ASCII text
  if (bytes.length >= 4) {
    let evenNul = 0, oddNul = 0;
    const n = Math.min(bytes.length, 2000);
    for (let i = 0; i < n; i++) if (bytes[i] === 0) { if (i % 2 === 0) evenNul++; else oddNul++; }
    if (oddNul > n * 0.3 && evenNul === 0) return { text: new TextDecoder("utf-16le").decode(bytes), encoding: "utf-16le" };
    if (evenNul > n * 0.3 && oddNul === 0) return { text: new TextDecoder("utf-16be").decode(bytes), encoding: "utf-16be" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252" };
  }
}

/** True when the buffer looks like text (few control characters, no NUL runs). */
export function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  if (n === 0) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i]!;
    if (b === 0) return decodeUtf16Likely(bytes);
    if (b < 9 || (b > 13 && b < 32)) bad++;
  }
  return bad / n < 0.02;
}

function decodeUtf16Likely(bytes: Uint8Array): boolean {
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return true;
  let nul = 0;
  const n = Math.min(bytes.length, 2000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) nul++;
  return nul > n * 0.3;
}
