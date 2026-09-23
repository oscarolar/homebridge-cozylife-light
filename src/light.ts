import {CharacteristicValue, PlatformAccessory, Service} from 'homebridge';
import {Attributes, CozyLifeClient} from './client';
import {Coalescer} from './coalescer';
import {
  ALL_ATTRS, ATTR, MIRED_MAX, MIRED_MIN, MODE_STATIC,
  brightnessFromDevice, brightnessToDevice, hueToDevice, isSet,
  miredFromDevice, miredToDevice, saturationFromDevice, saturationToDevice,
} from './mapping';
import type {CozyLifeLightPlatform, LightConfig} from './platform';

// Consecutive failed polls before the accessory is reported as not responding.
const OFFLINE_AFTER_FAILURES = 2;

export class CozyLifeLight {
  private readonly service: Service;
  private readonly client: CozyLifeClient;
  private readonly coalescer: Coalescer;
  private readonly pollTimer: NodeJS.Timeout;

  // Last known state in HomeKit units. Reads are answered from here, never
  // from the device, so opening the Home app doesn't hit the bulb.
  private on = false;
  private brightness = 100;
  private hue = 0;
  private saturation = 0;
  private mired = MIRED_MIN;
  // Color being sent, which HomeKit writes as separate Hue and Saturation sets.
  private pendingHue?: number;
  private pendingSaturation?: number;
  private failedPolls = 0;

  constructor(
    private readonly platform: CozyLifeLightPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: LightConfig,
  ) {
    const {Service, Characteristic} = platform.api.hap;
    this.client = new CozyLifeClient(config.ip, config.port ?? 5555, (config.timeout ?? 5) * 1000);
    this.coalescer = new Coalescer(data => this.write(data));

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'CozyLife')
      .setCharacteristic(Characteristic.Model, accessory.context.pid ?? 'Light')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.did ?? config.ip)
      .setCharacteristic(Characteristic.FirmwareRevision, accessory.context.sv ?? '0.0.0');

    this.service = accessory.getService(Service.Lightbulb)
      ?? accessory.addService(Service.Lightbulb, config.name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.read(this.on))
      .onSet(value => this.coalescer.add({[ATTR.POWER]: value ? 255 : 0}).then(() => {
        this.on = value as boolean;
      }));

    this.service.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.read(this.brightness))
      .onSet(value => this.coalescer.add({[ATTR.BRIGHT]: brightnessToDevice(value as number)}).then(() => {
        this.brightness = value as number;
      }));

    if (config.color !== false) {
      this.service.getCharacteristic(Characteristic.Hue)
        .onGet(() => this.read(this.hue))
        .onSet(value => this.setColor({hue: value as number}));
      this.service.getCharacteristic(Characteristic.Saturation)
        .onGet(() => this.read(this.saturation))
        .onSet(value => this.setColor({saturation: value as number}));
    }

    this.service.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({minValue: MIRED_MIN, maxValue: MIRED_MAX})
      .onGet(() => this.read(this.mired))
      .onSet(value => this.coalescer.add({
        [ATTR.MODE]: MODE_STATIC,
        [ATTR.WHITE]: miredToDevice(value as number),
      }).then(() => {
        this.mired = value as number;
      }));

    const pollSeconds = Math.max(30, config.pollInterval ?? 60);
    this.safePoll();
    this.pollTimer = setInterval(() => this.safePoll(), pollSeconds * 1000);
    platform.api.on('shutdown', () => clearInterval(this.pollTimer));
  }

  // Hue and saturation arrive as two separate sets; both are sent together
  // (the coalescer merges them) with mode 0, otherwise the bulb keeps white.
  // The second set must build on the first one's value, so the color in flight
  // is tracked apart from the confirmed state that HomeKit reads.
  private setColor(change: {hue?: number; saturation?: number}): Promise<void> {
    const hue = this.pendingHue = change.hue ?? this.pendingHue ?? this.hue;
    const saturation = this.pendingSaturation = change.saturation ?? this.pendingSaturation ?? this.saturation;
    return this.coalescer.add({
      [ATTR.MODE]: MODE_STATIC,
      [ATTR.HUE]: hueToDevice(hue),
      [ATTR.SAT]: saturationToDevice(saturation),
    }).then(() => {
      this.hue = hue;
      this.saturation = saturation;
    }).finally(() => {
      this.pendingHue = this.pendingSaturation = undefined;
    });
  }

  private read<T>(value: T): T {
    if (this.failedPolls >= OFFLINE_AFTER_FAILURES) {
      throw this.notResponding();
    }
    return value;
  }

  private async write(data: Attributes): Promise<void> {
    this.platform.log.debug(`${this.config.name}: set ${JSON.stringify(data)}`);
    try {
      await this.client.set(data);
      this.failedPolls = 0;
    } catch (error) {
      this.platform.log.warn(`${this.config.name}: command failed: ${(error as Error).message}`);
      this.failedPolls++;
      throw this.notResponding();
    }
  }

  private safePoll(): void {
    this.poll().catch(error => this.platform.log.error(`${this.config.name}: poll failed: ${(error as Error).message}`));
  }

  private async poll(): Promise<void> {
    let state: Attributes;
    try {
      state = await this.client.query(ALL_ATTRS);
    } catch (error) {
      this.failedPolls++;
      if (this.failedPolls === OFFLINE_AFTER_FAILURES) {
        this.platform.log.warn(`${this.config.name}: not responding (${(error as Error).message})`);
      }
      return;
    }
    if (this.failedPolls >= OFFLINE_AFTER_FAILURES) {
      this.platform.log.info(`${this.config.name}: responding again`);
    }
    this.failedPolls = 0;
    this.applyState(state);
  }

  // Push externally made changes (wall switch, other apps) into HomeKit.
  // Some bulbs never report hue (always 65535), so hue/sat are only updated
  // when the device actually reports them.
  private applyState(state: Attributes): void {
    const {Characteristic} = this.platform.api.hap;
    const update = (characteristic: typeof Characteristic.On, value: CharacteristicValue) =>
      this.service.updateCharacteristic(characteristic, value);

    if (isSet(state[ATTR.POWER])) {
      this.on = state[ATTR.POWER] > 0;
      update(Characteristic.On, this.on);
    }
    if (isSet(state[ATTR.BRIGHT])) {
      this.brightness = brightnessFromDevice(state[ATTR.BRIGHT]);
      update(Characteristic.Brightness, this.brightness);
    }
    if (isSet(state[ATTR.WHITE])) {
      this.mired = miredFromDevice(state[ATTR.WHITE]);
      update(Characteristic.ColorTemperature, this.mired);
    }
    if (this.config.color !== false && isSet(state[ATTR.HUE]) && isSet(state[ATTR.SAT])) {
      this.hue = state[ATTR.HUE];
      this.saturation = saturationFromDevice(state[ATTR.SAT]);
      update(Characteristic.Hue, this.hue);
      update(Characteristic.Saturation, this.saturation);
    }
  }

  private notResponding() {
    const {HapStatusError, HAPStatus} = this.platform.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
