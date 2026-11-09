export type GatewayTarget = {
  user: string;
  app_id: string;
  pushkey: string;
  payload: string;
};
type Json = Record<string, unknown>;
type Device = {
  app_id: string;
  pushkey: string;
  pushkey_ts: number;
  data: Json;
  tweaks?: Json;
};
type Notification = Json & { counts: { unread: number }; devices: Device[] };

/** Only protocol-selected fields cross the gateway boundary. Minimal format
 * cannot accidentally acquire content/names/tweaks from an event-shaped spread. */
export function gatewayPayload(
  target: GatewayTarget,
  unread: number,
  event: Json | null,
  actions: unknown[],
  names: {
    sender_display_name?: string;
    room_name?: string;
    room_alias?: string;
  } = {},
): { notification: Notification } {
  const stored = JSON.parse(target.payload);
  const { url: _url, ...data } = stored.data as Json;
  const device: Device = {
    app_id: target.app_id,
    pushkey: target.pushkey,
    pushkey_ts: Math.floor(Number(stored.added_ms) / 1000),
    data,
  };
  const notification: Notification = { counts: { unread }, devices: [device] };
  if (event === null) return { notification };
  notification.event_id = event.event_id;
  notification.room_id = event.room_id;
  const tweaks: Json = {};
  for (const action of actions) {
    if (
      action && typeof action === 'object' &&
      typeof (action as Json).set_tweak === 'string'
    ) {
      const tweak = action as Json;
      tweaks[String(tweak.set_tweak)] =
        tweak.set_tweak === 'highlight' && !Object.hasOwn(tweak, 'value')
          ? true
          : tweak.value;
    }
  }
  notification.prio = event.type === 'm.room.encrypted' || tweaks.sound ||
      tweaks.highlight === true
    ? 'high'
    : 'low';
  if (data.format === 'event_id_only') return { notification };
  notification.type = event.type;
  notification.sender = event.sender;
  notification.content = event.content;
  Object.assign(notification, names);
  if (event.type === 'm.room.member') {
    notification.membership = (event.content as Json)?.membership;
    notification.user_is_target = event.state_key === target.user;
  }
  device.tweaks = tweaks;
  return { notification };
}
