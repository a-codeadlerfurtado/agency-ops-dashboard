# Deployment and rollback

Build `leonardo-video-worker:3.0.3` from the included Dockerfile. Deploy the
stack as `leonardo-video-worker-v3`, with one replica, using the existing
Supabase and Google Drive secrets. Keep `leonardo-render:1.0.0` unchanged.

Smoke test the healthcheck and a `test_mode=true` job before enabling
`VIDEO_EDIT_ENABLED`. Rollback is performed by setting that flag to false and
removing only the V3 stack; the legacy service remains available.
