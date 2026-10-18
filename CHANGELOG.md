# Changelog

## 0.2.0

- Matter support (`supports-matter`): on Homebridge 2.x bridges with Matter
  enabled, each bulb is also exposed as a Matter light (Extended Color Light, or
  Color Temperature Light for `color: false`) so Google Home and other Matter
  controllers can use it. On/off, brightness, hue/saturation, xy color and
  color temperature.
- One device per bulb shared by the HomeKit and Matter views: still a single
  connection, a single poll and coalesced writes per bulb. Changes made from one
  side show up on the other.
- HomeKit accessories, UUIDs and behavior are unchanged; Homebridge 1.x and
  bridges without Matter keep working as before.

## 0.1.2

- Declare HAP support (`supports-hap` keyword).
- Config schema: list required fields in object-level `required` arrays
  instead of per-property booleans.

## 0.1.1

- Catch and log errors during platform setup and state polling instead of
  leaving unhandled promise rejections.
- CI on Node.js 22 and 24.

## 0.1.0

- First release: on/off, brightness, color and white temperature for CozyLife
  bulbs over the local API (TCP 5555), with serialized connections per bulb,
  coalesced HomeKit writes, cached reads and 60 s polling.
