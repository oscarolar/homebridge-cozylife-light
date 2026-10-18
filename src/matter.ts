import type {API, MatterAccessory, MatterAPI} from 'homebridge';
import type {CozyLifeDevice, LightState, UpdateSource} from './device';
import {
  MATTER_LEVEL_MAX, MATTER_LEVEL_MIN, MIRED_MAX, MIRED_MIN,
  clampMired, degreesToMatterHue, enhancedHueToDegrees, hueSaturationToXy, levelToLitPercent, levelToPercent,
  matterHueToDegrees, matterSaturationToPercent, percentToLevel, percentToMatterSaturation, xyToHueSaturation,
} from './mapping';

type Cluster = 'onOff' | 'levelControl' | 'colorControl' | 'bridgedDeviceBasicInformation';
const CLUSTERS: Cluster[] = ['onOff', 'levelControl', 'colorControl', 'bridgedDeviceBasicInformation'];
type Attributes = Record<string, unknown>;
type Changes = Partial<Record<Cluster, Attributes>>;
type Handlers = NonNullable<MatterAccessory['handlers']>;

export interface MatterInfo {
  did?: string;
  pid?: string;
  sv?: string;
}

// Matter guard: Homebridge 1.x has no isMatterEnabled, and on 2.x api.matter is
// only defined on bridges with a `matter` block.
export function matterApi(api: API): MatterAPI | undefined {
  const enabled = typeof api.isMatterEnabled === 'function' && api.isMatterEnabled();
  return enabled ? api.matter : undefined;
}

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

// Matter view of a bulb, backed by the shared device. Matter reads are served
// by Homebridge from the endpoint's own state, which is kept in sync here by
// pushing device updates, so controllers never cause a request to the bulb.
export class CozyLifeMatterLight {
  readonly accessory: MatterAccessory;
  // What the Matter endpoint holds: re-read from Homebridge on every poll
  // (matter.js changes it on its own for move/step commands), and updated with
  // what a command commits or what we push in between.
  private readonly endpoint: Record<Cluster, Attributes> =
    {onOff: {}, levelControl: {}, colorControl: {}, bridgedDeviceBasicInformation: {}};
  // matter.js runs MoveToHueAndSaturation as the combined handler and then the
  // hue and the saturation handlers with the same values: the next call of each
  // is skipped so one command is one write.
  private echo?: {hue?: number; saturation?: number};
  // Registration completes asynchronously and Homebridge drops (at debug level)
  // state updates for endpoints that don't exist yet, so nothing is pushed
  // until the endpoint is there.
  private registered = false;

  constructor(
    private readonly matter: MatterAPI,
    private readonly device: CozyLifeDevice,
    readonly UUID: string,
    info: MatterInfo,
    private readonly log: {debug(message: string): void; warn(message: string): void},
  ) {
    const color = device.hasColor;
    this.accessory = {
      UUID,
      displayName: device.name,
      deviceType: color ? matter.deviceTypes.ExtendedColorLight : matter.deviceTypes.ColorTemperatureLight,
      serialNumber: info.did ?? device.config.ip,
      manufacturer: 'CozyLife',
      model: info.pid ?? 'Light',
      firmwareRevision: info.sv ?? '0.0.0',
      context: {ip: device.config.ip},
      clusters: {
        onOff: this.desired('onOff'),
        levelControl: {...this.desired('levelControl'), minLevel: MATTER_LEVEL_MIN, maxLevel: MATTER_LEVEL_MAX},
        colorControl: {
          ...this.desired('colorControl'),
          colorTempPhysicalMinMireds: MIRED_MIN,
          colorTempPhysicalMaxMireds: MIRED_MAX,
          // required by matter.js conformance with the ColorTemperature feature
          coupleColorTempToLevelMinMireds: MIRED_MIN,
        },
      },
      handlers: this.handlers(),
    };
    device.onUpdate((state, source) => this.update(source));
  }

  // Resolves once Homebridge has created the endpoint, then syncs it with the
  // bulb. Never rejects.
  async whenRegistered(timeoutMs = 60000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (!this.registered) {
      try {
        if (await this.matter.getAccessoryState(this.UUID, 'onOff') !== undefined) {
          break;
        }
      } catch {
        // not ready yet
      }
      if (Date.now() > end) {
        this.log.warn(`${this.device.name}: Matter accessory not registered after ${timeoutMs / 1000} s`);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 250).unref());
    }
    this.registered = true;
    this.update('poll');
  }

  private handlers(): Handlers {
    const {device} = this;
    const {ColorMode} = this.matter.types.ColorControl;
    const level = (value: number) => Math.min(Math.max(value, MATTER_LEVEL_MIN), MATTER_LEVEL_MAX);
    const hs = {colorMode: ColorMode.CurrentHueAndCurrentSaturation, enhancedColorMode: ColorMode.CurrentHueAndCurrentSaturation};
    const handlers: Handlers = {
      onOff: {
        on: () => this.run(device.setOn(true), {onOff: {onOff: true}}),
        off: () => this.run(device.setOn(false), {onOff: {onOff: false}}),
        toggle: () => {
          const known = this.endpoint.onOff.onOff;
          return this.run(device.setOn(!device.state.on), typeof known === 'boolean' ? {onOff: {onOff: !known}} : {});
        },
      },
      levelControl: {
        moveToLevel: args =>
          this.run(device.setBrightness(levelToLitPercent(args.level)), {levelControl: {currentLevel: level(args.level)}}),
        moveToLevelWithOnOff: args => {
          if (args.level <= MATTER_LEVEL_MIN) {
            // Off at the minimum level: the bulb keeps its brightness for the
            // next "on", and the update after the write pushes that level back.
            return this.run(device.setOn(false), {onOff: {onOff: false}, levelControl: {currentLevel: MATTER_LEVEL_MIN}});
          }
          return this.run(Promise.all([device.setOn(true), device.setBrightness(levelToLitPercent(args.level))]),
            {onOff: {onOff: true}, levelControl: {currentLevel: level(args.level)}});
        },
        step: args => {
          const up = args.stepMode === this.matter.types.LevelControl.StepMode.Up;
          const target = percentToLevel(device.state.brightness) + (up ? args.stepSize : -args.stepSize);
          // matter.js steps from its own level, which may differ: let the
          // update after the write re-assert the bulb's.
          delete this.endpoint.levelControl.currentLevel;
          return this.run(device.setBrightness(levelToLitPercent(target)), {});
        },
        // Continuous dimming (button held) has no equivalent on the bulb; the
        // next poll re-reads the endpoint and brings it back to the real level.
        move: () => undefined,
        stop: () => undefined,
      },
      colorControl: {
        // matter.js crops to the physical range before committing.
        moveToColorTemperatureLogic: args => {
          const mired = clampMired(args.colorTemperatureMireds);
          return this.run(device.setMired(mired), {colorControl: {
            colorTemperatureMireds: mired,
            colorMode: ColorMode.ColorTemperatureMireds,
            enhancedColorMode: ColorMode.ColorTemperatureMireds,
          }});
        },
        // matter.js also calls this when it switches color modes.
        stopAllColorMovement: () => undefined,
      },
    };
    if (device.hasColor) {
      Object.assign(handlers.colorControl!, {
        moveToHueAndSaturationLogic: async (args: {hue: number; saturation: number}) => {
          this.echo = {hue: args.hue, saturation: args.saturation};
          try {
            await this.run(device.setColor({
              hue: matterHueToDegrees(args.hue),
              saturation: matterSaturationToPercent(args.saturation),
            }), {colorControl: {...hs, currentHue: args.hue, currentSaturation: args.saturation}});
          } catch (error) {
            // matter.js won't follow up after a failure
            this.echo = undefined;
            throw error;
          }
        },
        moveToHueLogic: (args: {targetHue: number; isEnhancedHue: boolean}) => {
          if (this.isEcho('hue', args.targetHue) && !args.isEnhancedHue) {
            return;
          }
          const hue = args.isEnhancedHue ? enhancedHueToDegrees(args.targetHue) : matterHueToDegrees(args.targetHue);
          const committed = args.isEnhancedHue ? {enhancedCurrentHue: args.targetHue} : {currentHue: args.targetHue};
          return this.run(device.setColor({hue}), {colorControl: {...hs, ...committed}});
        },
        moveToSaturationLogic: (args: {targetSaturation: number}) => {
          if (this.isEcho('saturation', args.targetSaturation)) {
            return;
          }
          return this.run(device.setColor({saturation: matterSaturationToPercent(args.targetSaturation)}),
            {colorControl: {...hs, currentSaturation: args.targetSaturation}});
        },
        moveToColorLogic: (args: {targetX: number; targetY: number}) =>
          this.run(device.setColor(xyToHueSaturation(args.targetX, args.targetY)), {colorControl: {
            currentX: args.targetX,
            currentY: args.targetY,
            colorMode: ColorMode.CurrentXAndCurrentY,
            enhancedColorMode: ColorMode.CurrentXAndCurrentY,
          }}),
      });
    }
    return handlers;
  }

  // Consumes the pending echo for `key`: true when this call repeats it.
  private isEcho(key: 'hue' | 'saturation', value: number): boolean {
    const echo = this.echo;
    if (!echo || echo[key] === undefined) {
      return false;
    }
    const repeated = echo[key] === value;
    delete echo[key];
    if (echo.hue === undefined && echo.saturation === undefined) {
      this.echo = undefined;
    }
    return repeated;
  }

  // Waits for the device write and maps a failure to a Matter status. On
  // success the endpoint commits the commanded values itself; record them so
  // they are not pushed back.
  private async run(write: Promise<unknown>, committed: Changes): Promise<void> {
    try {
      await write;
    } catch {
      throw new this.matter.status.Failure(`${this.device.name} is not responding`);
    }
    for (const [cluster, attributes] of Object.entries(committed) as [Cluster, Attributes][]) {
      Object.assign(this.endpoint[cluster], attributes);
    }
  }

  private desired(cluster: Cluster): Attributes {
    const state: Readonly<LightState> = this.device.state;
    switch (cluster) {
    case 'onOff':
      return {onOff: state.on};
    case 'levelControl':
      return {currentLevel: percentToLevel(state.brightness)};
    case 'bridgedDeviceBasicInformation':
      return {reachable: this.device.isOnline};
    case 'colorControl': {
      const {ColorMode} = this.matter.types.ColorControl;
      if (!this.device.hasColor || state.mode === 'white') {
        const mode = ColorMode.ColorTemperatureMireds;
        return this.device.hasColor
          ? {...this.colorAttributes(), colorTemperatureMireds: state.mired, colorMode: mode, enhancedColorMode: mode}
          : {colorTemperatureMireds: state.mired, colorMode: mode, enhancedColorMode: mode};
      }
      const mode = ColorMode.CurrentHueAndCurrentSaturation;
      return {...this.colorAttributes(), colorTemperatureMireds: state.mired, colorMode: mode, enhancedColorMode: mode};
    }
    }
  }

  private colorAttributes(): Attributes {
    const {hue, saturation} = this.device.state;
    const {x, y} = hueSaturationToXy(hue, saturation);
    return {
      currentHue: degreesToMatterHue(hue),
      currentSaturation: percentToMatterSaturation(saturation),
      currentX: x,
      currentY: y,
    };
  }

  // Attributes where the endpoint disagrees with the bulb, compared in bulb
  // units so rounding between the two scales doesn't cause writes.
  private stale(): Changes {
    const state = this.device.state;
    const {ColorMode} = this.matter.types.ColorControl;
    const changes: Changes = {};
    const desired = (cluster: Cluster, keys: string[]) => {
      const all = this.desired(cluster);
      changes[cluster] = {...changes[cluster], ...Object.fromEntries(keys.map(key => [key, all[key]]))};
    };

    if (this.endpoint.bridgedDeviceBasicInformation.reachable !== this.device.isOnline) {
      desired('bridgedDeviceBasicInformation', ['reachable']);
    }
    // Before the first poll the defaults would overwrite the restored state.
    if (!this.device.hasState) {
      return changes;
    }
    if (this.endpoint.onOff.onOff !== state.on) {
      desired('onOff', ['onOff']);
    }
    const level = this.endpoint.levelControl.currentLevel;
    if (typeof level !== 'number'
      || (levelToPercent(level) !== state.brightness && percentToLevel(state.brightness) !== level)) {
      desired('levelControl', ['currentLevel']);
    }
    const color = this.endpoint.colorControl;
    if (typeof color.colorTemperatureMireds !== 'number' || clampMired(color.colorTemperatureMireds) !== state.mired) {
      desired('colorControl', ['colorTemperatureMireds']);
    }
    if (!this.device.hasColor || state.mode === 'white') {
      if (color.colorMode !== ColorMode.ColorTemperatureMireds) {
        desired('colorControl', ['colorMode', 'enhancedColorMode']);
      }
    } else if (!this.colorMatches(color)) {
      desired('colorControl', ['currentHue', 'currentSaturation', 'currentX', 'currentY', 'colorMode', 'enhancedColorMode']);
    }
    return changes;
  }

  private colorMatches(color: Attributes): boolean {
    const {ColorMode} = this.matter.types.ColorControl;
    const {hue, saturation} = this.device.state;
    const numbers = (...values: unknown[]) => values.every(value => typeof value === 'number');
    let shown: {hue: number; saturation: number};
    if (color.colorMode === ColorMode.CurrentHueAndCurrentSaturation && numbers(color.currentHue, color.currentSaturation)) {
      shown = {
        hue: matterHueToDegrees(color.currentHue as number),
        saturation: matterSaturationToPercent(color.currentSaturation as number),
      };
    } else if (color.colorMode === ColorMode.CurrentXAndCurrentY && numbers(color.currentX, color.currentY)) {
      shown = xyToHueSaturation(color.currentX as number, color.currentY as number);
    } else {
      return false;
    }
    // xy goes through a color space conversion, hence the tolerance; hue is
    // meaningless for (nearly) white.
    return Math.abs(shown.saturation - saturation) <= 2 && (saturation <= 2 || hueDistance(shown.hue, hue) <= 2);
  }

  private update(source: UpdateSource): void {
    if (!this.registered) {
      return;
    }
    if (source === 'write') {
      this.push();
      return;
    }
    this.refresh()
      .then(() => this.push())
      .catch(error => this.log.warn(`${this.device.name}: Matter sync failed: ${(error as Error)?.message ?? error}`));
  }

  // Reading endpoint state is local to Homebridge; it never reaches the bulb.
  private async refresh(): Promise<void> {
    for (const cluster of CLUSTERS) {
      const state = await this.matter.getAccessoryState(this.UUID, cluster);
      if (state) {
        this.endpoint[cluster] = {...state};
      }
    }
  }

  private push(): void {
    for (const [cluster, changed] of Object.entries(this.stale()) as [Cluster, Attributes][]) {
      Object.assign(this.endpoint[cluster], changed);
      this.log.debug(`${this.device.name}: Matter ${cluster} ${JSON.stringify(changed)}`);
      try {
        this.matter.updateAccessoryState(this.UUID, cluster, changed).catch(error => this.pushFailed(cluster, changed, error));
      } catch (error) {
        this.pushFailed(cluster, changed, error);
      }
    }
  }

  private pushFailed(cluster: Cluster, attributes: Attributes, error: unknown): void {
    for (const key of Object.keys(attributes)) {
      delete this.endpoint[cluster][key];
    }
    this.log.warn(`${this.device.name}: Matter state update failed: ${(error as Error)?.message ?? error}`);
  }
}
