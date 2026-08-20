import express, { type Request, type Response, type NextFunction } from "express";
import { env } from "./env.js";
import { aiRouter, aiErrorHandler } from "./routes/ai.js";

const app = express();

// Atras do Traefik: sem isso o rate limit e os logs enxergam o IP do proxy.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));

// Em producao o frontend e' servido no mesmo dominio (Traefik roteia /api/ai
// para ca'), entao ALLOWED_ORIGINS fica vazio e nenhuma origem externa passa.
// A lista existe so' para desenvolvimento local.
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.header("origin");
  if (origin && env.allowedOrigins.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    res.setHeader("access-control-allow-methods", "POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(origin && env.allowedOrigins.includes(origin) ? 204 : 403);
    return;
  }
  res.setHeader("cache-control", "no-store");
  next();
});

// Healthcheck sem autenticacao e sem segredo: e' o que o Docker/Traefik consulta.
app.get("/api/ai/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: "agency-ops-ai-server",
    commit: env.gitCommit,
    model: env.anthropicModel,
    uptime_s: Math.round(process.uptime()),
  });
});

app.use("/api/ai", aiRouter);
app.use("/api/ai", aiErrorHandler);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ ok: false, error: "not_found" });
});

const server = app.listen(env.port, () => {
  console.log(`[ai] escutando em :${env.port} | modelo ${env.anthropicModel} | commit ${env.gitCommit}`);
});

// O Swarm manda SIGTERM ao trocar de versao. Encerrar as conexoes em aberto
// evita cortar uma resposta do Claude no meio durante um deploy.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[ai] ${signal} recebido, encerrando...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
