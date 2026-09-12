import { cors } from '@pathfinder/pathfinder/middleware';

// Same open CORS posture on the communico listener: the lite web client is
// served from a different origin (:8787) and its ws upgrade must carry the
// header too.
export default cors({
  origin: '*',
  headers: 'Authorization, Content-Type',
  methods: 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
});
