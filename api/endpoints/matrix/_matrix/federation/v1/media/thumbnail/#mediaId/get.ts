import { theApp } from '#engine/app.ts';
import { config, serverName } from '#engine/config.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { multipartResponse } from '#engine/media/multipart.ts';
import { thumbnailQuery } from '#engine/media/thumbnail.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  return multipartResponse(
    await theApp().media.thumbnail(
      serverName(),
      request.params.mediaId as string,
      '',
      thumbnailQuery(request.query, config().media.maxdimension),
      false,
      false,
      request._raw.signal,
    ),
  );
}
