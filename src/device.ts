import type {Logging} from 'homebridge';
import {Attributes, CozyLifeClient} from './client';
import {Coalescer} from './coalescer';
import {
  ALL_ATTRS, ATTR, MIRED_MIN, MODE_STATIC,
  brightnessFromDevice, brightnessToDevice, hueToDevice, isSet,
  miredFromDevice, miredToDevice, saturationFromDevice, saturationToDevice,
} from './mapping';
import type {LightConfig} from './platform';

// Consecutive failed polls before the light is reported as not responding.
const OFFLINE_AFTER_FAILURES = 2;

export interface LightState {
  on: boolean;
  brightness: number; // 0..100
  hue: number; // 0..360
  saturation: number; // 0..100
  mired: number; // MIRED_MIN..MIRED_MAX
  // Last known output: color (hue/saturation) or white (temperature).
  mode: 'color' | 'white';
}

export class DeviceNotRespondingError extends Error {}

// 'poll' when the bulb's state was read (or it went offline/online), 'write'
// after a successful command.
export type UpdateSource = 'poll' | 'write';

// One bulb, whatever views (HomeKit, Matter) expose it. The bulb handles a
// single TCP connection at a time, so the client, the write coalescer and the
// poll timer live here exactly once and the views only read the cached state.
export class CozyLifeDevice {
  private readonly client: CozyLifeClient;
  private readonly coalescer: Coalescer;
  private readonly listeners: ((state: Readonly<LightState>, source: UpdateSource) => void)[] = [];
  private pollTimer?: NodeJS.Timeout;
  private pendingSource?: UpdateSource;
  private stopped = false;

  // Last known state. Reads are answered from here, never from the device,
  // so opening a controller app doesn't hit the bulb.
  private readonly current: LightState = {
    on: false, brightness: 100, hue: 0, saturation: 0, mired: MIRED_MIN, mode: 'white',
  };
  // Color being sent: controllers may write hue and saturation separately.
  private pendingHue?: number;
  private pendingSaturation?: number;
  private failedPolls = 0;
  private known = false;
  // Whether this bulb has ever reported hue/saturation (some never do).
  private reportsHue = false;

  constructor(
    readonly config: LightConfig,
    private readonly log: Logging,
  ) {
    this.client = new CozyLifeClient(config.ip, config.port ?? 5555, (config.timeout ?? 5) * 1000);
    this.coalescer = new Coalescer(data => this.write(data));
  }

  get name(): string {
    return this.config.name;
  }

  get state(): Readonly<LightState> {
    return this.current;
  }

  get isOnline(): boolean {
    return this.failedPolls < OFFLINE_AFTER_FAILURES;
  }

  // False until a poll or write has told us the bulb's real state.
  get hasState(): boolean {
    return this.known;
  }

  get hasColor(): boolean {
    return this.config.color !== false;
  }

  // Called after a poll applied the bulb's state and after a successful write.
  onUpdate(listener: (state: Readonly<LightState>, source: UpdateSource) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.pollTimer || this.stopped) {
      return;
    }
    const pollSeconds = Math.max(30, this.config.pollInterval ?? 60);
    this.safePoll();
    this.pollTimer = setInterval(() => this.safePoll(), pollSeconds * 1000);
  }

  // Final: a stopped device neither polls nor notifies again.
  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  setOn(on: boolean): Promise<void> {
    return this.coalescer.add({[ATTR.POWER]: on ? 255 : 0}).then(() => {
      this.current.on = on;
      this.notify('write');
    });
  }

  setBrightness(percent: number): Promise<void> {
    return this.coalescer.add({[ATTR.BRIGHT]: brightnessToDevice(percent)}).then(() => {
      this.current.brightness = percent;
      this.notify('write');
    });
  }

  // Hue and saturation are sent together (the coalescer merges separate sets)
  // with mode 0, otherwise the bulb keeps white. A second set must build on the
  // first one's value, so the color in flight is tracked apart from the
  // confirmed state that controllers read.
  setColor(change: {hue?: number; saturation?: number}): Promise<void> {
    const hue = this.pendingHue = change.hue ?? this.pendingHue ?? this.current.hue;
    const saturation = this.pendingSaturation = change.saturation ?? this.pendingSaturation ?? this.current.saturation;
    return this.coalescer.add({
      [ATTR.MODE]: MODE_STATIC,
      [ATTR.HUE]: hueToDevice(hue),
      [ATTR.SAT]: saturationToDevice(saturation),
    }).then(() => {
      this.current.hue = hue;
      this.current.saturation = saturation;
      this.current.mode = 'color';
      this.notify('write');
    }).finally(() => {
      this.pendingHue = this.pendingSaturation = undefined;
    });
  }

  setMired(mired: number): Promise<void> {
    return this.coalescer.add({
      [ATTR.MODE]: MODE_STATIC,
      [ATTR.WHITE]: miredToDevice(mired),
    }).then(() => {
      this.current.mired = mired;
      this.current.mode = 'white';
      this.notify('write');
    });
  }

  private async write(data: Attributes): Promise<void> {
    this.log.debug(`${this.name}: set ${JSON.stringify(data)}`);
    try {
      await this.client.set(data);
      this.failedPolls = 0;
      this.known = true;
    } catch (error) {
      this.log.warn(`${this.name}: command failed: ${(error as Error).message}`);
      this.failedPolls++;
      if (this.failedPolls === OFFLINE_AFTER_FAILURES) {
        this.notify('poll');
      }
      throw new DeviceNotRespondingError(`${this.name} is not responding`);
    }
  }

  private safePoll(): void {
    this.poll().catch(error => this.log.error(`${this.name}: poll failed: ${(error as Error).message}`));
  }

  private async poll(): Promise<void> {
    let state: Attributes;
    try {
      state = await this.client.query(ALL_ATTRS);
    } catch (error) {
      this.failedPolls++;
      if (this.failedPolls === OFFLINE_AFTER_FAILURES) {
        this.log.warn(`${this.name}: not responding (${(error as Error).message})`);
        this.notify('poll');
      }
      return;
    }
    if (this.failedPolls >= OFFLINE_AFTER_FAILURES) {
      this.log.info(`${this.name}: responding again`);
    }
    this.failedPolls = 0;
    this.known = true;
    this.applyState(state);
    this.notify('poll');
  }

  // Externally made changes (wall switch, other apps). Some bulbs never report
  // hue (always 65535, also in color mode), so hue/sat are only updated when
  // actually reported. White mode is detected when a bulb that does report hue
  // stops reporting it, or, for bulbs that never do, when the white value
  // changes (color commands don't touch it).
  private applyState(state: Attributes): void {
    const hueReported = isSet(state[ATTR.HUE]) && isSet(state[ATTR.SAT]);
    const whiteChanged = isSet(state[ATTR.WHITE]) && miredFromDevice(state[ATTR.WHITE]) !== this.current.mired;
    if (this.hasColor && !hueReported && (this.reportsHue || whiteChanged)) {
      this.current.mode = 'white';
    }
    if (isSet(state[ATTR.POWER])) {
      this.current.on = state[ATTR.POWER] > 0;
    }
    if (isSet(state[ATTR.BRIGHT])) {
      this.current.brightness = brightnessFromDevice(state[ATTR.BRIGHT]);
    }
    if (isSet(state[ATTR.WHITE])) {
      this.current.mired = miredFromDevice(state[ATTR.WHITE]);
    }
    if (this.hasColor && hueReported) {
      this.reportsHue = true;
      this.current.hue = state[ATTR.HUE];
      this.current.saturation = saturationFromDevice(state[ATTR.SAT]);
      this.current.mode = 'color';
    }
  }

  // Deferred so every caller of a coalesced write has applied its part of the
  // state before the views see it, and listeners never run inside a handler.
  private notify(source: UpdateSource): void {
    if (this.pendingSource) {
      this.pendingSource = this.pendingSource === 'poll' ? 'poll' : source;
      return;
    }
    this.pendingSource = source;
    setImmediate(() => {
      const pending = this.pendingSource!;
      this.pendingSource = undefined;
      if (this.stopped) {
        return;
      }
      for (const listener of this.listeners) {
        try {
          listener(this.current, pending);
        } catch (error) {
          this.log.error(`${this.name}: update failed: ${(error as Error).message}`);
        }
      }
    });
  }
}
