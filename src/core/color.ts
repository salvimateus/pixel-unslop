export const TRANSPARENT = 0;

const OPAQUE = 0xff000000;

/** Opaque color. Layout 0xAABBGGRR, so a Uint32Array over RGBA bytes reads it directly on little-endian. */
export function pack(r: number, g: number, b: number): number {
  return (OPAQUE | ((b & 0xff) << 16) | ((g & 0xff) << 8) | (r & 0xff)) >>> 0;
}

export function red(color: number): number {
  return color & 0xff;
}

export function green(color: number): number {
  return (color >>> 8) & 0xff;
}

export function blue(color: number): number {
  return (color >>> 16) & 0xff;
}

export function alpha(color: number): number {
  return color >>> 24;
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, '0');
}

/** '#rrggbb', lowercase. Do not call it with TRANSPARENT. */
export function toHex(color: number): string {
  return `#${hexByte(red(color))}${hexByte(green(color))}${hexByte(blue(color))}`;
}

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Accepts '#rgb' and '#rrggbb', with or without '#'. Returns null when the text is not a color. */
export function fromHex(text: string): number | null {
  const match = HEX_PATTERN.exec(text.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3) digits = digits[0] + digits[0] + digits[1] + digits[1] + digits[2] + digits[2];
  const value = Number.parseInt(digits, 16);
  return pack((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

const SRGB_TO_LINEAR = (() => {
  const table = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    table[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return table;
})();

export function toOklab(color: number): [number, number, number] {
  const r = SRGB_TO_LINEAR[red(color)];
  const g = SRGB_TO_LINEAR[green(color)];
  const b = SRGB_TO_LINEAR[blue(color)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function deltaOk(a: number, b: number): number {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** OKLab L, 0 to 1. */
export function lightness(color: number): number {
  return toOklab(color)[0];
}
