<p align="center"><img src="assets/icon.png" width="128" alt="homebridge-cozylife-light icon"></p>

# homebridge-cozylife-light

[![npm](https://img.shields.io/npm/v/homebridge-cozylife-light)](https://www.npmjs.com/package/homebridge-cozylife-light)
[![Build and test](https://github.com/oscarolar/homebridge-cozylife-light/actions/workflows/build.yml/badge.svg)](https://github.com/oscarolar/homebridge-cozylife-light/actions/workflows/build.yml)

Homebridge plugin for **CozyLife** smart bulbs (Doiting ESP-based bulbs sold under
CozyLife and other brands), controlled over their **local LAN API**, with no cloud
and no CozyLife account.

Why: these bulbs also ship native HomeKit, but on some units it's slow (seconds
per command) or stops responding. The local API answers in about 100 ms, as long as
it's not flooded. This plugin is built around that limit.

## Features

- On/off, brightness, color (hue/saturation) and white color temperature.
- **One connection at a time per bulb.** The bulbs handle a single TCP connection;
  concurrent or rapid-fire requests make them queue commands for seconds.
- **Coalesced commands.** HomeKit sends a color change as several separate
  characteristic writes, and the plugin merges them into one device command.
- **Gentle polling.** State is read every 60 s by default (min 30 s) to pick up
  wall-switch changes. HomeKit reads are answered from cache.

## Configuration

Give each bulb a DHCP reservation in your router (accessories are keyed by IP), then:

```json
{
  "platform": "CozyLifeLight",
  "name": "CozyLife Light",
  "lights": [
    { "name": "Techo Estudio", "ip": "192.168.1.123" }
  ]
}
```

| Option | Default | |
|---|---|---|
| `name`, `ip` | required | |
| `color` | `true` | `false` for white-only bulbs |
| `pollInterval` | `60` | seconds, minimum 30 |
| `timeout` | `5` | seconds per command |
| `port` | `5555` | |

If the bulb is also paired natively in the Home app, you'll see it twice. Once
you're happy with this one, remove the native accessory. Some bulbs may leave
Wi-Fi when unpaired, so make sure you can re-provision it (CozyLife app) first.

## Protocol notes

Newline-delimited JSON over TCP 5555. `cmd 0` = info (includes `rssi`), `cmd 2` =
read attributes, `cmd 3` = write. Light attributes: `1` power (0/255), `2` mode
(**0 = static**; other values run built-in effects, and sending a color with a
non-zero mode makes the bulb blink into a preset), `3` white 0–1000, `4` brightness
0–1000, `5` hue 0–360, `6` saturation 0–1000; `65535` = unset. Scales follow
CozyLife's own Home Assistant integration
([cozylife/hass_cozylife_local_pull](https://github.com/cozylife/hass_cozylife_local_pull)).

Tested with a CozyLife Light-L5 (firmware 1.0.8) on Homebridge 2.4.

## Development

```bash
npm install
npm test   # builds, then runs tests against a fake bulb
```
