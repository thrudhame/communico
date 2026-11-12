// Both discovery dialects describe the same external authorization service.
import { config } from '#engine/config.ts';

export function rtcTransports() {
  const livekit_service_url = config().matrixrtc.livekitserviceurl;
  return livekit_service_url === ''
    ? []
    : [{ type: 'livekit', livekit_service_url }];
}

// deno-lint-ignore require-await
export async function transportDiscovery() {
  const transports = rtcTransports();
  return transports.length === 0 ? {} : { rtc_transports: transports };
}
