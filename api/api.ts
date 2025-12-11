import * as path from "@std/path";
import { pick } from "@std/collections";
import { walkSync } from "@std/fs/walk";
import { helpers, Router } from "@oak/oak";

const router = new Router();


type T_API_METHOD = (a: string, b: string) => boolean | string;

// console.log('>', path.relative("/data/foobar", "/data/foobar/impl/bbb"));

const basePath = path.join(Deno.cwd(), "api/endpoints/");

const apiMethods = {};

for (
  const dirEntry of walkSync(basePath, { includeDirs: false, exts: ["ts"] })
) {
  const apiFile = dirEntry.path;
  const { dir: route, name: method } = pick(
    path.parse(path.relative(basePath, dirEntry.path)),
    ["dir", "name"],
  );

  console.log("-", apiFile, ">", route, "+", method);

  const apiClass: any = await import(`file://${apiFile}`);
  const api: any = apiClass.default;

  if (!api) {
    console.warn(`Could not load '${apiFile}' api method.`);
    continue;
  }

  api();

  router.add(method.toUpperCase(), `/${route}`, (context) => {
    const payload = context.request.body({ type: 'json' });
    const params = context.params;

    console.log('+', method, route, '>', params, payload);

    const response = api(params, payload);

    console.log('response', response);
  });

  apiMethods[apiFile] = api;
}

console.log("apiMethods", apiMethods);

console.log("routes", router.routes());

console.log("allowedMethods", router.allowedMethods());
