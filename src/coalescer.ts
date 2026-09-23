import {Attributes} from './client';

// HomeKit sets one characteristic at a time: changing a color arrives as
// On + Hue + Saturation (+ Brightness) within a few milliseconds. Merge those
// into one write so the bulb gets a single command, and settle every caller
// with that write's outcome so the Home app shows the real result.
export class Coalescer {
  private pending: Attributes = {};
  private waiters: {resolve: () => void; reject: (error: Error) => void}[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly write: (data: Attributes) => Promise<void>,
    private readonly delayMs = 100,
  ) {}

  add(data: Attributes): Promise<void> {
    Object.assign(this.pending, data);
    return new Promise((resolve, reject) => {
      this.waiters.push({resolve, reject});
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.delayMs);
      }
    });
  }

  private flush(): void {
    const data = this.pending;
    const waiters = this.waiters;
    this.pending = {};
    this.waiters = [];
    this.timer = undefined;
    this.write(data).then(
      () => waiters.forEach(w => w.resolve()),
      error => waiters.forEach(w => w.reject(error)),
    );
  }
}
