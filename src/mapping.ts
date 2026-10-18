// Attribute ids and scales, as used by CozyLife's own Home Assistant integration
// (cozylife/hass_cozylife_local_pull):
//   1 power     0 off, 255 on (devices report 0/1)
//   2 mode      0 = static white/color. Other values run built-in effects, and
//               sending them with a color makes the bulb blink into a preset.
//   3 white     0..1000, where mired = 500 - value / 2 (1000 = coolest)
//   4 bright    0..1000
//   5 hue       0..360
//   6 sat       0..1000
// 65535 means "not set" (a bulb in white mode reports hue/sat as 65535).
export const ATTR = {POWER: '1', MODE: '2', WHITE: '3', BRIGHT: '4', HUE: '5', SAT: '6'} as const;
export const ALL_ATTRS = [1, 2, 3, 4, 5, 6];
export const UNSET = 65535;
export const MODE_STATIC = 0;

// HomeKit ColorTemperature range the bulb can reach (mired).
export const MIRED_MIN = 140;
export const MIRED_MAX = 500;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const brightnessToDevice = (percent: number) => clamp(Math.round(percent * 10), 0, 1000);
export const brightnessFromDevice = (value: number) => clamp(Math.round(value / 10), 0, 100);

export const saturationToDevice = (percent: number) => clamp(Math.round(percent * 10), 0, 1000);
export const saturationFromDevice = (value: number) => clamp(Math.round(value / 10), 0, 100);

export const hueToDevice = (degrees: number) => clamp(Math.round(degrees), 0, 360);

export const miredToDevice = (mired: number) => clamp(Math.round(1000 - mired * 2), 0, 1000);
export const miredFromDevice = (value: number) => clamp(Math.round(500 - value / 2), MIRED_MIN, MIRED_MAX);

export const isSet = (value: number | undefined): value is number =>
  value !== undefined && value !== UNSET;

// Matter scales (Matter 1.x Application Cluster spec, Level Control and Color Control):
//   currentLevel        1..254 for lights (minLevel 1)
//   currentHue          0..254 for 0..360 degrees
//   currentSaturation   0..254 for 0..100 %
//   currentX/currentY   CIE 1931 xy, 0..65279 for 0..~1
export const MATTER_LEVEL_MIN = 1;
export const MATTER_LEVEL_MAX = 254;
const MATTER_HUE_MAX = 254;
const MATTER_SAT_MAX = 254;
const MATTER_XY_MAX = 0xfeff;

// Level 1 is "minimum" (0 %); anything above it is at least 1 %.
export const levelToPercent = (level: number) => level <= MATTER_LEVEL_MIN
  ? 0
  : clamp(Math.round((level - MATTER_LEVEL_MIN) * 100 / (MATTER_LEVEL_MAX - MATTER_LEVEL_MIN)), 1, 100);
// For writes to a lit bulb: brightness 0 would leave it on but dark.
export const levelToLitPercent = (level: number) => Math.max(1, levelToPercent(level));
export const percentToLevel = (percent: number) =>
  clamp(Math.round(MATTER_LEVEL_MIN + percent * (MATTER_LEVEL_MAX - MATTER_LEVEL_MIN) / 100), MATTER_LEVEL_MIN, MATTER_LEVEL_MAX);

export const matterHueToDegrees = (hue: number) => clamp(Math.round(hue * 360 / MATTER_HUE_MAX), 0, 360);
export const degreesToMatterHue = (degrees: number) => clamp(Math.round(degrees * MATTER_HUE_MAX / 360), 0, MATTER_HUE_MAX);
export const enhancedHueToDegrees = (hue: number) => clamp(Math.round(hue * 360 / 65535), 0, 360);

export const matterSaturationToPercent = (saturation: number) => clamp(Math.round(saturation * 100 / MATTER_SAT_MAX), 0, 100);
export const percentToMatterSaturation = (percent: number) => clamp(Math.round(percent * MATTER_SAT_MAX / 100), 0, MATTER_SAT_MAX);

export const clampMired = (mired: number) => clamp(Math.round(mired), MIRED_MIN, MIRED_MAX);

// xy <-> hue/saturation through sRGB (D65), ignoring brightness: the bulb only
// takes hue/saturation, while Matter controllers may send or read xy.
const gammaEncode = (c: number) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
const gammaDecode = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

export function xyToHueSaturation(x: number, y: number): {hue: number; saturation: number} {
  const cx = x / 65535;
  const cy = Math.max(y / 65535, 1e-6);
  const X = cx / cy;
  const Z = (1 - cx - cy) / cy;
  const linear = [
    3.2406 * X - 1.5372 - 0.4986 * Z,
    -0.9689 * X + 1.8758 + 0.0415 * Z,
    0.0557 * X - 0.2040 + 1.0570 * Z,
  ].map(c => Math.max(0, c));
  const max = Math.max(...linear) || 1;
  const [r, g, b] = linear.map(c => gammaEncode(c / max));
  const high = Math.max(r, g, b);
  const delta = high - Math.min(r, g, b);
  let hue = 0;
  if (delta > 0) {
    if (high === r) {
      hue = 60 * (((g - b) / delta + 6) % 6);
    } else if (high === g) {
      hue = 60 * ((b - r) / delta + 2);
    } else {
      hue = 60 * ((r - g) / delta + 4);
    }
  }
  return {
    hue: clamp(Math.round(hue), 0, 360),
    saturation: clamp(Math.round(high === 0 ? 0 : delta / high * 100), 0, 100),
  };
}

export function hueSaturationToXy(hue: number, saturation: number): {x: number; y: number} {
  const s = clamp(saturation, 0, 100) / 100;
  const sector = ((hue % 360) + 360) % 360 / 60;
  const f = sector - Math.floor(sector);
  const p = 1 - s;
  const q = 1 - s * f;
  const t = 1 - s * (1 - f);
  const [r, g, b] = [
    [1, t, p], [q, 1, p], [p, 1, t], [p, q, 1], [t, p, 1], [1, p, q],
  ][Math.floor(sector) % 6].map(gammaDecode);
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = 0.0193 * r + 0.1192 * g + 0.9505 * b;
  const sum = X + Y + Z;
  return {
    x: clamp(Math.round(X / sum * 65535), 0, MATTER_XY_MAX),
    y: clamp(Math.round(Y / sum * 65535), 0, MATTER_XY_MAX),
  };
}
