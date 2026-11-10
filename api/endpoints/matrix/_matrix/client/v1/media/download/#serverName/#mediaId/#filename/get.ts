import { theApp } from '#engine/app.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest, context: Context) {
  return await theApp().media.download(
    request.params.serverName as string,
    request.params.mediaId as string,
    context.state.user as string,
    request.params.filename as string,
    request.query.get('allow_remote') !== 'false',
  );
}
