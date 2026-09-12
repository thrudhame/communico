// deno-lint-ignore require-await
export default async function (request: import('@pathfinder/pathfinder').PathfinderRequest) {
  console.log('CONTROL' + request.method, request.params, request.body);
  return 'type + POST';
}
