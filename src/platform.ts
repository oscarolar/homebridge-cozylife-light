import {API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig} from 'homebridge';
import {CozyLifeClient} from './client';
import {CozyLifeLight} from './light';

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

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    api.on('didFinishLaunching', () => {
      this.setup().catch(error => this.log.error(`Setup failed: ${(error as Error).message}`));
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private async setup(): Promise<void> {
    const lights: LightConfig[] = (this.config.lights ?? []).filter((l: LightConfig) => l?.ip && l?.name);
    const wanted = new Set<string>();

    for (const light of lights) {
      // Keyed by IP: reserve the bulb's address in the router (DHCP reservation).
      const uuid = this.api.hap.uuid.generate(`cozylife-light:${light.ip}`);
      if (wanted.has(uuid)) {
        // two handlers would mean two connections to one bulb
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
      new CozyLifeLight(this, accessory, light);
    }

    const stale = [...this.cached.values()].filter(a => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach(a => this.log.info(`Removed ${a.displayName}`));
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
