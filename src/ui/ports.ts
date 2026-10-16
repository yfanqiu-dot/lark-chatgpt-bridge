import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// Fetch Standard 2.9, checked 2026-10-12:
// https://fetch.spec.whatwg.org/#port-blocking
const blocked = new Set([0,1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,4190,5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);
export function browserHttpPort(port: number): boolean { return Number.isSafeInteger(port) && port > 0 && port <= 65535 && !blocked.has(port); }
/** OS ephemeral ranges may include browser-blocked ports. Close a rejected
 * ephemeral listener before trying a fresh allocation; explicit ports are
 * never silently replaced and ordinary bind errors are not retried. */
export async function listenBrowserPort(server: Server, host: string, requested = 0): Promise<number> {
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > 65535) throw new Error('Invalid UI port');
  if (requested && !browserHttpPort(requested)) throw new Error('UI port is blocked by browser Fetch policy');
  for (let attempt=0;attempt<8;attempt++) {
    const port = await new Promise<number>((done,reject) => {
      const failed=(e:Error)=>{server.removeListener('error',failed);reject(e);};
      server.once('error',failed);
      server.listen(requested,host,()=>{server.removeListener('error',failed);done((server.address() as AddressInfo).port);});
    });
    if(browserHttpPort(port))return port;
    await new Promise<void>((done,reject)=>server.close(e=>e?reject(e):done()));
    if(requested)throw new Error('UI listener port differs from requested browser port');
  }
  throw new Error('No browser-compatible UI port was allocated');
}
