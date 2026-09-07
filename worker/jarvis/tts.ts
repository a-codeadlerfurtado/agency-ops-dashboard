/**
 * Sintese de voz -- fase 2.
 *
 * Na fase 1 quem fala e o `speechSynthesis` do proprio navegador. A rota existe
 * desde agora com o contrato fechado para que o frontend possa tentar o servidor
 * primeiro e cair no navegador ao receber 501, sem precisar mudar de codigo
 * quando o Kokoro entrar.
 *
 * Fase 2, quando KOKORO_URL existir:
 *
 *   const chave = sha256(`${voice}:${text}`);
 *   const guardado = await env.JARVIS_CACHE.get(chave, "arrayBuffer");
 *   if (guardado) return new Response(guardado, { headers: { "content-type": "audio/ogg" } });
 *
 *   const r = await fetch(env.KOKORO_URL, {
 *     method: "POST",
 *     headers: { "content-type": "application/json", "x-jarvis-token": env.KOKORO_TOKEN },
 *     body: JSON.stringify({ text, voice }),
 *     signal: AbortSignal.timeout(20_000),
 *   });
 *   const audio = await r.arrayBuffer();
 *   await env.JARVIS_CACHE.put(chave, audio, { expirationTtl: 60 * 60 * 24 * 7 });
 *   return new Response(audio, { headers: { "content-type": "audio/ogg" } });
 *
 * O cache e por sha256 do texto porque as frases se repetem muito -- saudacao,
 * "Confirmo?", "Feito." -- e sintetizar de novo o que ja foi sintetizado e o
 * gasto mais bobo desse caminho.
 */

import type { EnvJarvis } from "./tools";

export type EntradaTts = { text: string; voice?: string };

export async function sintetizar(_request: Request, _env: EnvJarvis): Promise<Response> {
  return Response.json(
    {
      error: "tts_phase_2",
      contrato: {
        method: "POST",
        body: { text: "string", voice: "pt-br-f" },
        resposta_esperada: "audio/ogg",
      },
      enquanto_isso: "use speechSynthesis no navegador",
    },
    { status: 501 },
  );
}
