# Leonardo Imobi video worker v3

Autonomous worker for the Supabase video queue. It downloads originals from Google Drive, creates low-resolution proxies, performs temporal analysis, selects non-black segments, renders 9:16 H.264, runs mandatory QA, uploads idempotently to Drive, and reports the result to Supabase.

Production requires SUPABASE_URL, VIDEO_EDIT_WORKER_TOKEN, and either GOOGLE_SERVICE_ACCOUNT_JSON or the three Google OAuth refresh-token variables. No credential is stored in the image.

The process uses one job at a time. Supabase owns atomic locking, heartbeat recovery, retries, job idempotency, review state, and test-mode isolation. Google Drive uploads use appProperties (video_job_id, variant) to prevent duplicates after a timeout.

Local validation:

    python worker.py --local-manifest local-test-manifest.json --output output.mp4

Rollback: keep the current leonardo-render:1.0.0 service and image unchanged until v3 passes remote smoke tests. Deploy v3 as leonardo-video-worker-v3 with one replica and its own persistent /data volume, then enable VIDEO_EDIT_ENABLED.


Backfill temporal is disabled by default. After the render smoke test, enable `VIDEO_ANALYSIS_ENABLED=true` with `VIDEO_ANALYSIS_BUDGET=1` to process exactly one queued analysis per worker process before increasing the budget.
