# Agency Processor

External worker for heavy Agency Ops jobs on the LeonardoImobi server managed by Portainer.

Current production service: `agency-processor_agency-processor`.

## Runtime

- Image: `node:22-alpine`
- Worker ID: `leonardoimobi-primary-1`
- Queue polling: adaptive 5s to 60s
- Worker API timeout: 90s
- Check-overdue interval: 120s
- Worker API: scoped Supabase Edge gateway
- Supabase service role is NOT stored in Portainer

## Check-overdue cutover

The external worker runs `check_overdue` in `execute` mode. The old constant `check-overdue-1min` cron is disabled.
A lightweight Supabase watchdog invokes the legacy function only if there has been no successful external execute run for more than 10 minutes.
`envios_bot` cleanup is handled by a lightweight hourly database cron.

## Files

- `stack.yml`: Portainer stack currently deployed
- `worker-v2.mjs`: worker source extracted from the deployed inline stack

Secrets are injected through Portainer environment variables and must never be committed.
