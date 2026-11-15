// Login flows list (no auth). matrix-commander probes the r0 alias of
// this exact shape (see demo/capture/endpoints-capture.md row 1).
import { config } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';
export default async function () {
  const settings = config();
  return {
    flows: settings.server.role === 'facade' &&
        (!settings.facade.replicatecredentials ||
          !await theApp().replica?.passwordLogin?.())
      ? []
      : [{ type: 'm.login.password' }],
  };
}
