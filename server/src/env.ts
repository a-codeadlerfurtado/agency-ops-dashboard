// Configuracao do backend. Tudo vem do ambiente da VPS: nenhuma credencial
// privilegiada pode existir no bundle do navegador.

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export const env = {
  port: Number(optional("PORT", "8787")),

  supabaseUrl: required("SUPABASE_URL"),
  // Chave publica: usada SOMENTE para validar o access token do usuario.
  supabasePublishableKey: required("SUPABASE_PUBLISHABLE_KEY"),
  // Chave privilegiada server-side (sb_secret_... ou service_role legado).
  // Nunca sai da VPS e nunca recebe o Authorization do usuario.
  supabaseSecretKey: required("SUPABASE_SECRET_KEY"),

  openaiApiKey: required("OPENAI_API_KEY"),
  // Mesmo modelo que o OpsQuestion ja' roda nesta VPS. Manter os dois iguais
  // evita a IA e o OpsQuestion divergirem respondendo sobre o mesmo dado.
  openaiModel: optional("OPENAI_MODEL", "gpt-5-mini"),
  openaiMaxTokens: Number(optional("OPENAI_MAX_TOKENS", "8000")),

  // Em producao o frontend e' same-origin (Traefik roteia /api/ai para ca'),
  // entao a lista fica vazia e nenhum cross-origin e' aceito.
  allowedOrigins: optional("ALLOWED_ORIGINS", "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),

  maxMessageChars: Number(optional("MAX_MESSAGE_CHARS", "30000")),
  historyLimit: Number(optional("HISTORY_LIMIT", "30")),
  rateLimitPerMinute: Number(optional("RATE_LIMIT_PER_MINUTE", "20")),

  gitCommit: optional("GIT_COMMIT", "desconhecido"),
} as const;
