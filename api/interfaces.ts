import type {
  HttpError,
  HTTPMethods,
  Request,
  RouterContext,
  Status,
} from "@oak/oak";
import type { ResponseBody, ResponseBodyFunction } from "@oak/oak/response";

export interface TApiComponentRequest {
  body: Request["body"];
  headers: Headers;
  ips: string[];
  method: HTTPMethods;
  userAgent: Request["userAgent"];
  // not in oak's request
  params: RouterContext<string>["params"];
}

export interface TApiComponentResponseOptions {
  body: ResponseBody | ResponseBodyFunction | null | undefined;
  headers: Headers | null | undefined;
  status: Status | null | undefined;
  // Content-Type
  type: string | null | undefined;
}

export type TApiComponentResponse =
  | ResponseBody
  | ResponseBodyFunction
  | TApiComponentResponseOptions;

export type TApiComponentOutcome = Promise<
  [HttpError<Status.InternalServerError> | null, TApiComponentResponse | null]
>;

export type TApiComponent = (
  request: TApiComponentRequest,
) => TApiComponentOutcome;
