# Changelog

## 0.1.1

- Catch and log errors during platform setup and state polling instead of
  leaving unhandled promise rejections.
- CI on Node.js 22 and 24.

## 0.1.0

- First release: on/off, brightness, color and white temperature for CozyLife
  bulbs over the local API (TCP 5555), with serialized connections per bulb,
  coalesced HomeKit writes, cached reads and 60 s polling.
