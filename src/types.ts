export interface Env {
  ASSETS: Fetcher;
  AI: Ai;
  ROOM: DurableObjectNamespace;
  ROOM_PASSWORD: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET?: string;
  GEMINI_API_KEY?: string;
  TAVILY_API_KEY?: string;
  GEMINI_MODEL: string;
  GEMINI_BACKUP_MODEL?: string;
  WORKERS_AI_MODEL: string;
  DEFAULT_PROVIDER: string;
}

export interface SessionUser {
  name: string;
  admin: boolean;
}

// ---- 與模型無關的對話格式 ----

export type Part =
  | { text: string }
  | { image: { mime: string; data: string } }
  | { call: { id: string; name: string; args: Record<string, unknown>; sig?: string } }
  | { result: { id: string; name: string; response: unknown } };

export interface Turn {
  role: "user" | "model";
  parts: Part[];
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  calls: { id: string; name: string; args: Record<string, unknown>; sig?: string }[];
}

export interface Provider {
  id: "gemini" | "workers-ai";
  model: string;
  generate(opts: {
    system: string;
    turns: Turn[];
    tools?: ToolDecl[];
    onDelta?: (text: string) => void;
    json?: boolean;
  }): Promise<GenerateResult>;
}
