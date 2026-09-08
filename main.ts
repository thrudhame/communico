import project from './deno.json' with { type: 'json' };
import { Api } from './api/api.ts';
import { attachSocket } from './api/hats/lite/peer.ts';

const tagLine = `${project.name}: ${project.description}.`;

const matrixAPI = new Api('api/endpoints/', '_matrix/');
const communicoAPI = new Api('api/endpoints/', '_communico/');

await Promise.all([matrixAPI.setup(), communicoAPI.setup()]);

Deno.serve({ port: Number(Deno.env.get('APP_A_PORT') ?? '8008') }, async (request, info) => {
  const { pathname } = new URL(request.url);
  if (pathname === '/') {
    return new Response(tagLine);
  }

  const res = await matrixAPI.handle(request, info.remoteAddr);
  return res ?? Response.error();
});

Deno.serve({ port: Number(Deno.env.get('APP_B_PORT') ?? '8000') }, async (request, info) => {
  const url = new URL(request.url);
  const { pathname } = url;
  if (pathname === '/') {
    return new Response(tagLine);
  }

  // lite hat (design §4.4): browser peers join rooms over msync/ws.
  // The upgrade intercept must precede oak's handle() — it takes the raw
  // Request and would answer the upgrade as a plain (failing) HTTP call.
  if (
    pathname === '/msync' &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  ) {
    const roomId = url.searchParams.get('room');
    if (!roomId) return new Response('missing ?room=', { status: 400 });
    const { socket, response } = Deno.upgradeWebSocket(request);
    attachSocket(roomId, socket);
    return response;
  }

  const res = await communicoAPI.handle(request, info.remoteAddr);
  return res ?? Response.error();
});
