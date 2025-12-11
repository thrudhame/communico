import { Api } from "./api/api.ts";

const matrixAPI = new Api('api/endpoints/', '_matrix/');
await matrixAPI.setup();

const communicoAPI = new Api('api/endpoints/', '_communico/');
await communicoAPI.setup();

Deno.serve({ port: 80 }, async (request, info) => {
  const res = await matrixAPI.handle(request, info.remoteAddr);
  return res ?? Response.error();
});

Deno.serve({ port: 8000 }, async (request, info) => {
  const res = await communicoAPI.handle(request, info.remoteAddr);
  return res ?? Response.error();
});
