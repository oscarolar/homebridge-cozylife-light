import type {API, CharacteristicValue, PlatformAccessory, Service} from 'homebridge';
import type {CozyLifeDevice, LightState} from './device';
import {MIRED_MAX, MIRED_MIN} from './mapping';

// HomeKit view of a bulb: a Lightbulb service backed by the shared device.
export class CozyLifeLight {
  private readonly service: Service;

  constructor(
    private readonly api: API,
    accessory: PlatformAccessory,
    private readonly device: CozyLifeDevice,
  ) {
    const {Service, Characteristic} = api.hap;
    const {config} = device;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'CozyLife')
      .setCharacteristic(Characteristic.Model, accessory.context.pid ?? 'Light')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.did ?? config.ip)
      .setCharacteristic(Characteristic.FirmwareRevision, accessory.context.sv ?? '0.0.0');

    this.service = accessory.getService(Service.Lightbulb)
      ?? accessory.addService(Service.Lightbulb, config.name);

    this.service.getCharacteristic(Characteristic.On)
      .onGet(() => this.read(device.state.on))
      .onSet(value => this.write(device.setOn(value as boolean)));

    this.service.getCharacteristic(Characteristic.Brightness)
      .onGet(() => this.read(device.state.brightness))
      .onSet(value => this.write(device.setBrightness(value as number)));

    if (device.hasColor) {
      this.service.getCharacteristic(Characteristic.Hue)
        .onGet(() => this.read(device.state.hue))
        .onSet(value => this.write(device.setColor({hue: value as number})));
      this.service.getCharacteristic(Characteristic.Saturation)
        .onGet(() => this.read(device.state.saturation))
        .onSet(value => this.write(device.setColor({saturation: value as number})));
    }

    this.service.getCharacteristic(Characteristic.ColorTemperature)
      .setProps({minValue: MIRED_MIN, maxValue: MIRED_MAX})
      .onGet(() => this.read(device.state.mired))
      .onSet(value => this.write(device.setMired(value as number)));

    device.onUpdate(state => this.update(state));
  }

  private read<T>(value: T): T {
    if (!this.device.isOnline) {
      throw this.notResponding();
    }
    return value;
  }

  private write(result: Promise<void>): Promise<void> {
    return result.catch(() => {
      throw this.notResponding();
    });
  }

  // Push changes made by polls or by other controllers (e.g. Matter) into HomeKit.
  private update(state: Readonly<LightState>): void {
    const {Characteristic} = this.api.hap;
    const update = (characteristic: typeof Characteristic.On, value: CharacteristicValue) =>
      this.service.updateCharacteristic(characteristic, value);

    update(Characteristic.On, state.on);
    update(Characteristic.Brightness, state.brightness);
    update(Characteristic.ColorTemperature, state.mired);
    if (this.device.hasColor) {
      update(Characteristic.Hue, state.hue);
      update(Characteristic.Saturation, state.saturation);
    }
  }

  private notResponding() {
    const {HapStatusError, HAPStatus} = this.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
