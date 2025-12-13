import type {
  TApiComponent,
  TApiComponentRequest,
} from "@communico/api/interfaces";

import * as path from "@std/path";
import * as assert from "@std/assert";
import { pick } from "@std/collections";
import { walk } from "@std/fs/walk";
import {
  Application,
  createHttpError,
  type HTTPMethods,
  Router,
  Status,
} from "@oak/oak";

export class Api {
  private isHydrated: boolean = false;

  private readonly app: Application;
  private readonly router: Router;

  private readonly basePath: string;
  private readonly prefixPath: string;

  constructor(basePath: string, prefixPath: string = "") {
    this.app = new Application();
    this.router = new Router();

    this.basePath = path.resolve(Deno.cwd(), basePath);
    this.prefixPath = prefixPath;
  }

  public async setup() {
    assert.assertFalse(
      this.isHydrated,
      "Expect .setup to be invoked only once",
    );

    await this.#loadEndpoints();

    // Logger
    this.app.use(async (ctx, next) => {
      await next();
      const rt = ctx.response.headers.get("X-Response-Time");
      console.log(`${ctx.request.method} ${ctx.request.url} - ${rt}`);
    });

    // Timing
    this.app.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      const ms = Date.now() - start;
      ctx.response.headers.set("X-Response-Time", `${ms}ms`);
    });

    this.app.use(this.router.routes());
    this.app.use(this.router.allowedMethods());

    this.isHydrated = true;
  }

  public async handle(
    request: Request,
    secureOrAddr?: Deno.NetAddr | undefined,
    secure?: boolean | undefined,
  ): Promise<Response | undefined> {
    return await this.app.handle(request, secureOrAddr, secure);
  }

  async #loadEndpoints() {
    const searchPrefix = path.join(this.basePath, this.prefixPath);

    for await (
      const dirEntry of walk(searchPrefix, { includeDirs: false, exts: ["ts"] })
    ) {
      const apiFile = dirEntry.path;
      const { dir: route, name: method } = pick(
        path.parse(path.relative(this.basePath, dirEntry.path)),
        ["dir", "name"],
      );

      // deno-lint-ignore no-explicit-any
      const apiClass: any = await import(`file://${apiFile}`);
      const api: TApiComponent = apiClass.default;

      assert.assertExists(api, `Could not load '${apiFile}' api method.`);

      this.router.add(
        method.toUpperCase() as HTTPMethods,
        `/${route}`,
        async (context) => {
          const apiRequest: TApiComponentRequest = {
            body: context.request.body,
            headers: context.request.headers,
            ips: context.request.ips,
            method: context.request.method,
            userAgent: context.request.userAgent,
            params: context.params,
          };

          try {
            const [error, response] = await api(apiRequest);
            console.log("response", error, response);

            if (error != null) {
              console.error(error);
              throw error;
            }

            context.response.body = response;
          } catch (e) {
            console.error(e);
            throw createHttpError(
              Status.BadRequest,
              "The request was bad.",
              { expose: false },
            );
          }
        },
      );
    }
  }
}
