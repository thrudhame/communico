import * as path from '@std/path';
import * as assert from '@std/assert';
import { pick } from '@std/collections';
import { walkSync } from '@std/fs/walk';
import { Application, HTTPMethods, Router } from '@oak/oak';

export class Api {
  private isHydrated: boolean = false;

  private readonly app: Application;
  private readonly router: Router;

  private readonly basePath: string;
  private readonly prefixPath: string;

  constructor(basePath: string, prefixPath: string = '') {
    this.app = new Application();
    this.router = new Router();

    this.basePath = path.resolve(Deno.cwd(), basePath);
    this.prefixPath = prefixPath;
  }

  public async setup() {
    assert.assertFalse(this.isHydrated, 'Expect .setup to be invoked only once');

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

    for (
      const dirEntry of walkSync(searchPrefix, { includeDirs: false, exts: ['ts'] })
    ) {
      const apiFile = dirEntry.path;
      const { dir: route, name: method } = pick(
        path.parse(path.relative(this.basePath, dirEntry.path)),
        ["dir", "name"],
      );

      // deno-lint-ignore no-explicit-any
      const apiClass: any = await import(`file://${apiFile}`);
      // deno-lint-ignore no-explicit-any
      const api: any = apiClass.default;

      assert.assertExists(api, `Could not load '${apiFile}' api method.`);

      this.router.add(method.toUpperCase() as HTTPMethods, `/${route}`, (context) => {
        const payload = context.request.body;
        const params = context.params;

        console.log('+', method, route, '>', params, payload);

        const response = api(params, payload);

        console.log('response', typeof response, response);

        context.response.body = response;
      });
    }
  }
}

