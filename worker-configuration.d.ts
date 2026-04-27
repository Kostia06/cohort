declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    USER_AGENT_DO: DurableObjectNamespace;
    ANTHROPIC_API_KEY: string;
    AI_GATEWAY_URL: string;
    JWT_SECRET: string;
    RESEARCH: Fetcher;
  }
}
