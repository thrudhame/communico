import { mediaMaxBytes } from '#engine/media.ts';

// deno-lint-ignore require-await
export default async function () {
  return { 'm.upload.size': mediaMaxBytes() };
}
