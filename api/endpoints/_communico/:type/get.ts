import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from "@communico/api/interfaces";

// deno-lint-ignore require-await
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  console.log("CONTROL" + request.method, request.params, request.body);
  return [null, "type + GET"];
}
