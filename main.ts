import { Application, Router } from "@oak/oak";

const router = new Router();

router.get("/", (context) => {
  context.response.body = { "message": "Hello world" };
});

router.get("/message/:id", (context) => {
  if (context?.params?.id != null) {
    context.response.body = {
      message: `Message with id: ${context?.params?.id}`,
    };
  }
});

const app = new Application();

// Logger
app.use(async (ctx, next) => {
  await next();
  const rt = ctx.response.headers.get("X-Response-Time");
  console.log(`${ctx.request.method} ${ctx.request.url} - ${rt}`);
});

// Timing
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms}ms`);
});

app.use(router.routes());
app.use(router.allowedMethods());

// app.listen({port: 80});
Deno.serve({ port: 80 }, async (request, info) => {
  const res = await app.handle(request, info.remoteAddr);
  return res ?? Response.error();
});
