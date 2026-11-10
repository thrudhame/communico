import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { thumbnailQuery } from '#engine/media/thumbnail.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest) {
  return await theApp().media.thumbnail(
    request.params.serverName as string,
    request.params.mediaId as string,
    '',
    thumbnailQuery(request.query, config().media.maxdimension),
    false,
    true,
  );
}
