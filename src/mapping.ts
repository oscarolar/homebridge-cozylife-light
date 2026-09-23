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
