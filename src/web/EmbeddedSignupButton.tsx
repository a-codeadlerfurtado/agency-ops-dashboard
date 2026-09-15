'use client';

import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window { FB: any; fbAsyncInit: () => void; }
}

type SignupData = { wabaId?: string; phoneNumberId?: string; code?: string };

export function EmbeddedSignupButton() {
  const [cfg, setCfg] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const data = useRef<SignupData>({});

  useEffect(() => {
    fetch('/api/v1/whatsapp/embedded-signup/config', { credentials: 'include' })
      .then(r => r.json()).then(setCfg);
  }, []);

  useEffect(() => {
    if (!cfg) return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com' && event.origin !== 'https://web.facebook.com') return;
      try {
        const payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (payload?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (payload.event === 'FINISH') {
          data.current.wabaId = payload.data?.waba_id;
          data.current.phoneNumberId = payload.data?.phone_number_id;
          void finalizeIfReady();
        }
      } catch { /* evento nao-JSON do SDK */ }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [cfg]);

  async function finalizeIfReady() {
    const { code, wabaId, phoneNumberId } = data.current;
    if (!code || !wabaId || !phoneNumberId) return;
    const res = await fetch('/api/v1/whatsapp/embedded-signup/complete', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, wabaId, phoneNumberId })
    });
    setBusy(false);
    if (!res.ok) throw new Error(await res.text());
    location.reload();
  }

  function launch() {
    if (!cfg || !window.FB) return;
    setBusy(true);
    data.current = {};
    window.FB.login((response: any) => {
      const code = response?.authResponse?.code;
      if (!code) { setBusy(false); return; }
      data.current.code = code;
      void finalizeIfReady();
    }, {
      config_id: cfg.configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: cfg.extras ?? {}
    });
  }

  return <button onClick={launch} disabled={!cfg || busy}>{busy ? 'Conectando…' : 'Conectar WhatsApp'}</button>;
}
