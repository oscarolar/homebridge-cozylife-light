import type {API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig} from 'homebridge';
import {CozyLifeClient} from './client';
import {CozyLifeDevice} from './device';
import {CozyLifeLight} from './light';
import {CozyLifeMatterLight, matterApi} from './matter';

export const PLUGIN_NAME = 'homebridge-cozylife-light';
export const PLATFORM_NAME = 'CozyLifeLight';

export interface LightConfig {
  name: string;
  ip: string;
  port?: number;
  color?: boolean;
  pollInterval?: number;
  timeout?: number;
}

export class CozyLifeLightPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly cachedMatter = new Map<string, MatterAccessory>();
  private readonly devices: CozyLifeDevice[] = [];
  private shuttingDown = false;

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    api.on('didFinishLaunching', () => {
      this.setup().catch(error => this.log.error(`Setup failed: ${(error as Error).message}`));
    });
    api.on('shutdown', () => {
      this.shuttingDown = true;
      this.devices.forEach(device => device.stop());
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.cachedMatter.set(accessory.UUID, accessory);
  }

  private async setup(): Promise<void> {
    const lights: LightConfig[] = (this.config.lights ?? []).filter((l: LightConfig) => l?.ip && l?.name);
    const matter = matterApi(this.api);
    const wanted = new Set<string>();
    const matterLights: CozyLifeMatterLight[] = [];

    for (const light of lights) {
      // Keyed by IP: reserve the bulb's address in the router (DHCP reservation).
      const uuid = this.api.hap.uuid.generate(`cozylife-light:${light.ip}`);
      if (wanted.has(uuid)) {
        // two devices would mean two connections to one bulb
        this.log.warn(`${light.name}: ${light.ip} is configured more than once, ignoring this entry`);
        continue;
      }
      wanted.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(light.name, uuid);
        await this.describe(accessory, light);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${light.name} (${light.ip})`);
      }

      // One device per bulb, shared by every view: one connection, one poll.
      const device = new CozyLifeDevice(light, this.log);
      this.devices.push(device);
      new CozyLifeLight(this.api, accessory, device);
      if (matter) {
        const matterUuid = this.api.hap.uuid.generate(`cozylife-light-matter:${light.ip}`);
        matterLights.push(new CozyLifeMatterLight(matter, device, matterUuid, accessory.context, this.log));
      }
      // Views are attached, so the first poll reaches all of them. Matter
      // registration below must not delay HomeKit.
      if (!this.shuttingDown) {
        device.start();
      }
    }

    const stale = [...this.cached.values()].filter(a => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach(a => this.log.info(`Removed ${a.displayName}`));
    }

    if (matter) {
      await this.setupMatter(matterLights);
    }
  }

  // Cached Matter accessories are registered again too: that is what attaches
  // the handlers to the endpoint Homebridge restored from its cache.
  private async setupMatter(lights: CozyLifeMatterLight[]): Promise<void> {
    const matter = this.api.matter!;
    const wanted = new Set(lights.map(light => light.UUID));
    try {
      if (lights.length) {
        await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, lights.map(light => light.accessory));
        lights.forEach(light => light.whenRegistered());
        lights
          .filter(light => !this.cachedMatter.has(light.UUID))
          .forEach(light => this.log.info(`Added ${light.accessory.displayName} to Matter`));
      }
    } catch (error) {
      this.log.error(`Matter registration failed: ${(error as Error).message}`);
    }

    const stale = [...this.cachedMatter.values()].filter(a => !wanted.has(a.UUID));
    if (stale.length) {
      try {
        await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
        stale.forEach(a => this.log.info(`Removed ${a.displayName} from Matter`));
      } catch (error) {
        this.log.error(`Matter cleanup failed: ${(error as Error).message}`);
      }
    }
  }

  // Model/serial/firmware for the Home app; optional, the light works without it.
  private async describe(accessory: PlatformAccessory, light: LightConfig): Promise<void> {
    try {
      const info = await new CozyLifeClient(light.ip, light.port ?? 5555).info();
      Object.assign(accessory.context, {did: info.did, pid: info.pid, sv: info.sv});
    } catch (error) {
      this.log.warn(`${light.name}: could not read device info (${(error as Error).message})`);
    }
  }
}
