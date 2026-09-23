import net from 'net';

// CozyLife devices speak newline-delimited JSON over TCP (port 5555):
//   request  {"cmd":N,"pv":0,"sn":"<ms>","msg":{...}}\r\n
//   response {"cmd":N,"pv":0,"sn":"<ms>","msg":{...},"res":0}
// cmd 0 = device info, cmd 2 = read attributes, cmd 3 = write attributes.
export const CMD_INFO = 0;
export const CMD_QUERY = 2;
export const CMD_SET = 3;

export type Attributes = Record<string, number>;

export interface DeviceInfo {
  did: string;
  pid: string;
  mac: string;
  ip: string;
  rssi?: number;
  sv?: string;
  hv?: string;
}

interface Response {
  cmd: number;
  msg: Record<string, unknown>;
  res: number;
}

// The bulbs run a tiny single-connection TCP stack: concurrent or rapid-fire
// connections make them queue commands for seconds (and HomeKit reports
// "No Response"). Every request therefore goes through one promise chain, so a
// device never sees more than one connection at a time.
export class CozyLifeClient {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly host: string,
    readonly port = 5555,
    readonly timeoutMs = 5000,
  ) {}

  info(): Promise<DeviceInfo> {
    return this.request(CMD_INFO, {}).then(r => r.msg as unknown as DeviceInfo);
  }

  query(attrs: number[]): Promise<Attributes> {
    return this.request(CMD_QUERY, {attr: attrs}).then(r => (r.msg.data ?? {}) as Attributes);
  }

  set(data: Attributes): Promise<void> {
    const attr = Object.keys(data).map(Number);
    return this.request(CMD_SET, {attr, data}).then(() => undefined);
  }

  private request(cmd: number, msg: Record<string, unknown>): Promise<Response> {
    const run = () => this.send(cmd, msg);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private send(cmd: number, msg: Record<string, unknown>): Promise<Response> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      let buffer = '';
      let settled = false;
      const finish = (error: Error | null, response?: Response) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(response!);
        }
      };

      socket.setTimeout(this.timeoutMs, () =>
        finish(new Error(`timeout after ${this.timeoutMs} ms`)));
      socket.on('error', error => finish(error));
      socket.on('connect', () => {
        socket.write(JSON.stringify({cmd, pv: 0, sn: String(Date.now()), msg}) + '\r\n');
      });
      socket.on('data', chunk => {
        buffer += chunk.toString();
        const end = buffer.indexOf('\n');
        if (end < 0) {
          return;
        }
        let response: Response;
        try {
          response = JSON.parse(buffer.slice(0, end));
        } catch {
          return finish(new Error(`invalid response: ${buffer.slice(0, 80)}`));
        }
        if (response.res !== 0) {
          return finish(new Error(`device rejected cmd ${cmd} (res=${response.res})`));
        }
        finish(null, response);
      });
      socket.on('close', () => finish(new Error('connection closed without a response')));
    });
  }
}
