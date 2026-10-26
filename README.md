<p align="center"><img src="assets/icon.png" width="128" alt="homebridge-cozylife-light icon"></p>

# homebridge-cozylife-light

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
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
- HomeKit, plus **Matter** on Homebridge 2 bridges with Matter enabled (Google
  Home, Alexa, SmartThings, etc.). Both share one connection and one poll per bulb.
- **One connection at a time per bulb.** The bulbs handle a single TCP connection;
  concurrent or rapid-fire requests make them queue commands for seconds.
- **Coalesced commands.** HomeKit sends a color change as several separate
  characteristic writes, and the plugin merges them into one device command
  (also when HomeKit and Matter write at the same moment).
- **Gentle polling.** State is read every 60 s by default (min 30 s) to pick up
  wall-switch changes. HomeKit and Matter reads are answered from cache.

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

## Matter (Google Home, etc.)

Google Home and other non-Apple controllers can't see HomeKit accessories, but
they can pair a Matter bridge. With **Homebridge 2.x** and Matter enabled on the
bridge this plugin runs on, each bulb is also exposed over Matter (as an Extended
Color Light, or a Color Temperature Light when `color` is `false`). No plugin
option is needed; on Homebridge 1.x, or without Matter, the plugin is HomeKit-only
as before.

1. Enable Matter on the bridge in `config.json` (or in the Homebridge UI bridge
   settings). For the main bridge:

   ```json
   "bridge": {
     "name": "Homebridge",
     "username": "...",
     "port": 51826,
     "pin": "...",
     "matter": { "port": 5540 }
   }
   ```

   If the plugin runs as a child bridge, put the same `"matter"` block in the
   platform's `_bridge` section instead.
2. Restart Homebridge, then open the Matter QR code / pairing code for that bridge
   in the Homebridge UI.
3. In Google Home: **Add device → Matter-enabled device**, and scan the code. The
   bulbs appear under the Homebridge Matter bridge.

**Don't also add the Matter bridge to Apple Home.** HomeKit already shows the
bulbs through the regular Homebridge pairing, so pairing the Matter bridge there
too makes every bulb show up twice. Use Matter for Google (and other
controllers), HomeKit for Apple.

Matter controllers are kept in sync with the bulb by the same 60 s poll, and
with changes made from HomeKit right away (and vice versa).

## Protocol notes

Newline-delimited JSON over TCP 5555. `cmd 0` = info (includes `rssi`), `cmd 2` =
read attributes, `cmd 3` = write. Light attributes: `1` power (0/255), `2` mode
(**0 = static**; other values run built-in effects, and sending a color with a
non-zero mode makes the bulb blink into a preset), `3` white 0–1000, `4` brightness
0–1000, `5` hue 0–360, `6` saturation 0–1000; `65535` = unset. Scales follow
CozyLife's own Home Assistant integration
([cozylife/hass_cozylife_local_pull](https://github.com/cozylife/hass_cozylife_local_pull)).

Tested with a CozyLife Light-L5 (firmware 1.0.8) on Homebridge 2.4. Matter
support was checked against Homebridge 2.4's Matter server (matter.js 0.17) with a
simulated bulb.

## Development

```bash
npm install
npm test   # builds, then runs tests against a fake bulb
```
