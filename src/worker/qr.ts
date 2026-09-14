/**
 * QR generation. Two functions, nothing else.
 *
 * The QR encodes the PERMALINK, not the itms-services:// deep link. Two
 * reasons: the permalink is shorter (37 modules per side versus 53 for a
 * typical deep link, which scans noticeably better at the size a QR appears in
 * a PR comment), and it stays correct after the build is replaced.
 */

import { generatePngQrCode, generateSvgQrCode } from "@juit/qrcode";

const OPTIONS = { scale: 6, margin: 4, ecLevel: "M" } as const;

/**
 * @juit/qrcode emits `<svg …><path d="…"/></svg>` with NO background rect and
 * NO fill attribute, so the raw output is black-on-transparent -- invisible,
 * and therefore unscannable, on GitHub's dark theme. Inject an opaque white
 * ground and an explicit dark fill.
 */
export function qrSvg(text: string): string {
  return generateSvgQrCode(text, OPTIONS).replace(
    "<path",
    '<rect width="100%" height="100%" fill="#ffffff"/><path fill="#111111"',
  );
}

/**
 * PNG is what the PR comment embeds: it is opaque 8-bit greyscale, so it needs
 * no dark-theme wrapper, and GitHub's email notification pipeline strips SVG.
 *
 * Note this one is async -- the library uses CompressionStream.
 */
export async function qrPng(text: string): Promise<Uint8Array> {
  return generatePngQrCode(text, OPTIONS);
}
