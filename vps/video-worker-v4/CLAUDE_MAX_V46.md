# Video Worker V4.6 — Claude Max brain

## Scope

This branch keeps the V4.5 FFmpeg renderer, temporal analysis, approved-reference DNA,
critic and QA pipeline intact. Claude is added only as a planning/directing layer.

Flow:

raw materials -> temporal/existing analysis -> approved-reference package ->
Claude edit plan -> validated EditSpec JSON -> V4 timeline -> FFmpeg render ->
V4.5 approved-reference critic -> technical/visual QA -> MP4 -> human review

Automatic publication is not part of this integration.

## Safety model

- Production `main` is not changed by this branch.
- Claude jobs use the isolated variant `v4_claude_test`.
- The worker refuses `v4_auto` when Claude mode is enabled.
- DB kill switch: `agency_ops.automation_settings.VIDEO_CLAUDE_ENABLED`.
- Container kill switch: `VIDEO_CLAUDE_ENABLED=false` by default.
- Test fail-open is disabled: `VIDEO_CLAUDE_FAIL_OPEN=false`.
- Claude outputs always become `REVIEW_REQUIRED`.
- Existing V4.5 worker can continue serving normal `v4_auto` jobs.
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are explicitly rejected by
  the Claude adapter to prevent accidental API-billed authentication.

## Authentication

The image pins `@anthropic-ai/claude-code@2.1.288` and runs it on Node 22, matching
the package's current `node >=22` engine requirement.

Use a persistent Docker volume mounted at:

`/data/claude-config`

and keep:

`CLAUDE_CONFIG_DIR=/data/claude-config`

Authenticate interactively inside the isolated test container with the official Claude
login flow:

`claude auth login`

Do not put passwords, OAuth codes, API keys or generated credentials in environment
variables, Git, logs or chat.

Before enabling the worker, verify:

`claude auth status`

The V4.6 adapter requires:

- `loggedIn: true`
- `authMethod: "claude.ai"`
- `subscriptionType: "max"`

If `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is present, the worker refuses
to use Claude.

## Container configuration for the controlled test

Required existing V4 variables remain unchanged, including the Supabase worker token
Docker secret and Drive download/upload bridges.

Additional values:

```
VIDEO_WORKER_ID=leonardo-video-worker-v46-claude-test
VIDEO_CLAUDE_ENABLED=true
VIDEO_CLAUDE_VARIANT_FILTER=v4_claude_test
VIDEO_CLAUDE_FAIL_OPEN=false
VIDEO_CLAUDE_REQUIRE_MAX=true
VIDEO_CLAUDE_MODEL=opus
VIDEO_CLAUDE_EFFORT=high
VIDEO_CLAUDE_MAX_TURNS=12
VIDEO_CLAUDE_TIMEOUT_SECONDS=900
VIDEO_CLAUDE_MAX_REFERENCES=3
CLAUDE_CONFIG_DIR=/data/claude-config
```

Never add `ANTHROPIC_API_KEY` for the Max-subscription path.

## Queue isolation and retry

Migration `20261004011500_video_claude_max_v46.sql` adds
`claim_video_v4_render_job_variant(worker, variant)`.

The Claude worker sends `variant=v4_claude_test` on claim. The RPC uses
`FOR UPDATE SKIP LOCKED`, preserving atomic claim behavior. The migration also
redefines the generic V4 claim so legacy V4.5 workers explicitly exclude
`v4_claude%` variants; a live V4.5 worker therefore cannot steal the controlled
Claude job.

The existing V4 queue retains:

- unique `idempotency_key`
- stale-worker recovery
- retry attempt counting
- heartbeat
- output upsert by job/variant

This allows retry without creating duplicate render jobs or duplicate outputs.

## EditSpec contract

Claude receives a redacted `context.json` plus JPEG contact sheets generated from:

- raw video inputs
- approved-reference videos downloaded through the existing Drive bridge

Context also contains:

- product/client/benchmark/edit briefing
- existing temporal analysis
- existing creative analysis/transcription where available
- approved-reference DNA features
- baseline V4 timeline summary

Claude returns `claude-edit-spec-v1`, validated before it is converted to the V4
timeline. The schema covers:

- clip/source-window selection and order
- trim in/out and speed
- source volume
- stage
- transitions
- effects
- on-screen text
- captions
- narration direction
- music direction and volume
- 1080x1920 / 30 fps / 9:16
- safe zones
- brand/CTA/closing direction
- QA notes

Invalid asset IDs, invalid trims, repeated source windows, invalid transitions,
unsafe text positions, unsupported effects and invalid durations fail before render.

## Known renderer boundary

The current renderer can execute cuts, supported transitions/effects, text, captions,
music bed, sound events and brand-close graphics.

Narration can be planned in the EditSpec, but this branch does not add a TTS engine.
For the controlled test, narration should remain disabled unless an existing renderable
narration source is already supplied. This avoids silently inventing a voice pipeline.

## Controlled A/B candidate

Use source job:

`338189d6-50b9-4d60-b1c1-8039a359609a`

It is a test-mode job with exactly one raw input and has an existing V4.5 baseline output.
The V4.5 baseline passed QA and approved-reference critic. Reusing the same source keeps
the A/B comparison controlled.

Create only one additional render variant:

`v4_claude_test`

Do not alter or replace the existing `v4_auto` output.

## Acceptance checks

After V4.6 render:

- output exists and ffprobe opens it
- H.264 video
- AAC audio
- 1080x1920
- 30 fps
- duration within intended range
- no problematic black frame interval
- visual variation / no frozen render
- approved-reference critic PASS
- captions only when source transcription exists
- `review_status=REVIEW_REQUIRED`
- source job `current_stage=REVIEW_REQUIRED`
- no automatic publication

Compare against the V4.5 baseline on:

- duration
- number of shots
- average shot duration
- transition count
- CTA timing
- price/text timing
- critic score
- visual QA
- file size
- render/planning time

## Kill switch / rollback

Immediate logical shutdown:

1. set DB `VIDEO_CLAUDE_ENABLED=false`
2. set service env `VIDEO_CLAUDE_ENABLED=false` (or scale the Claude test service to 0)

Normal V4.5 `v4_auto` remains available because it is a separate worker/variant path.

Container rollback:

- redeploy the saved V4.5 service/container spec
- image: `leonardo-video-worker-v4:4.5.0`

Do not delete the Claude config volume during rollback; preserving it does not activate
Claude by itself.

## Portainer rule

Before deploying V4.6, export/record the live V4.5 service/container JSON from Portainer,
including image, env names (with secret values redacted), mounts, ports, command,
healthcheck, restart policy, networks, labels and resource limits.

Deploy V4.6 as an isolated test service first. Do not overwrite the live V4.5 worker
until the controlled A/B test has passed.
