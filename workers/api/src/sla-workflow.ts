import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { rpc, type Env } from "./lib/db";

export interface ParametrosSla {
  assignmentId: string;
  segundos: number;
  tentativa?: number;
}

interface ResultadoExpiracao {
  resultado:
    | "ja_aceito"
    | "ainda_no_prazo"
    | "redistribuido"
    | "devolvido_a_fila"
    | "ja_resolvido"
    | "nao_encontrado"
    | "sem_corretor_disponivel";
  novo_assignment_id?: string;
  expires_at?: string;
}

/**
 * SLA de aceite sem cron (spec 32 e 100).
 *
 * Um cron que varre leads vencidos a cada minuto acorda 1.440 vezes por dia
 * mesmo quando nao ha nada a fazer, e disputa CPU com os outros projetos desta
 * conta. Aqui cada lead distribuido cria uma instancia que dorme exatamente o
 * tempo do SLA e acorda uma vez. Zero trabalho ocioso.
 *
 * Idempotencia: `expirar_assignment` decide tudo dentro de uma transacao com
 * `for update`. Se a Cloudflare reexecutar este passo - o que ela pode fazer -
 * a segunda chamada devolve `ja_aceito` ou `ja_resolvido` e nada acontece duas
 * vezes. O Workflow nao guarda estado proprio de proposito: a verdade e o banco.
 */
export class WorkflowSla extends WorkflowEntrypoint<Env, ParametrosSla> {
  override async run(evento: WorkflowEvent<ParametrosSla>, passo: WorkflowStep): Promise<void> {
    const { assignmentId, segundos } = evento.payload;
    const tentativa = evento.payload.tentativa ?? 1;

    // O prazo respeita o expediente da fila, entao pode ser de minutos (lead
    // que chega as 14h) ou de dias (lead que chega sexta as 20h). O Workflow
    // dorme o tempo que for - e por isso que nao existe cron aqui.
    await passo.sleep("aguardar o prazo de aceite", `${Math.max(segundos, 30)} seconds`);

    const r = await passo.do(
      `verificar aceite (tentativa ${tentativa})`,
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } },
      async (): Promise<ResultadoExpiracao> =>
        rpc<ResultadoExpiracao>(this.env, "expirar_assignment", {
          p_assignment_id: assignmentId,
        })
    );

    // Acordou cedo (relogio/skew): volta a dormir o tempo que falta em vez de
    // marcar SLA perdido indevidamente.
    if (r.resultado === "ainda_no_prazo" && r.expires_at) {
      const faltam = Math.ceil((new Date(r.expires_at).getTime() - Date.now()) / 1000);
      if (faltam > 0) {
        await passo.sleep("aguardar o tempo restante", `${faltam + 5} seconds`);
        await passo.do("reverificar aceite", async () =>
          rpc<ResultadoExpiracao>(this.env, "expirar_assignment", {
            p_assignment_id: assignmentId,
          })
        );
      }
      return;
    }

    // Redistribuido: o proximo corretor tem o proprio prazo, entao o proprio
    // Workflow encadeia a instancia seguinte. Sem cron, sem fila de varredura.
    if (r.resultado === "redistribuido" && r.novo_assignment_id) {
      await passo.do("abrir o SLA do proximo corretor", async () => {
        await this.env.SLA.create({
          id: `assignment-${r.novo_assignment_id}`,
          params: {
            assignmentId: r.novo_assignment_id!,
            segundos,
            tentativa: tentativa + 1,
          } satisfies ParametrosSla,
        });
        return { encadeado: r.novo_assignment_id };
      });
    }
  }
}
