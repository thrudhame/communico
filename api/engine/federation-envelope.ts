// Pure wire encoding shared by admission and the destination sender.
export function encodeEnvelope(
  origin: string,
  ts: number,
  pdus: Record<string, unknown>[],
  edus: { edu_type: string; content: Record<string, unknown> }[],
): string {
  return JSON.stringify({ origin, origin_server_ts: ts, pdus, edus });
}
