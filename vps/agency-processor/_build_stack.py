from pathlib import Path
base = Path('stack.yml').read_text(encoding='utf-8-sig').rstrip()
js = Path('onboarding-worker.mjs').read_text(encoding='utf-8-sig').rstrip()
indented = '\n'.join(('        ' + line) if line else '        ' for line in js.splitlines())
addon = f'''\n\n  onboarding-processor:\n    image: node:22-alpine\n    environment:\n      ONBOARDING_API_URL: "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-onboarding-worker-api"\n      AGENCY_WORKER_TOKEN: "${{AGENCY_WORKER_TOKEN}}"\n      WORKER_ID: "leonardoimobi-onboarding-1"\n      ONBOARDING_DEFAULT_INTERVAL_MS: "900000"\n      API_TIMEOUT_MS: "90000"\n      WORKER_SCRIPT: |\n{indented}\n    command:\n      - sh\n      - -lc\n      - 'node -e "$$WORKER_SCRIPT"'\n    deploy:\n      replicas: 1\n      restart_policy:\n        condition: any\n        delay: 5s\n      resources:\n        limits:\n          cpus: "0.50"\n          memory: 256M\n        reservations:\n          memory: 64M\n'''
out = Path('stack-onboarding-shadow.yml')
out.write_text(base + addon + '\n', encoding='utf-8')
print(f'CREATED {out} lines={len((base+addon).splitlines())}')
