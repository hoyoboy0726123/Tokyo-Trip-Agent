export interface Env {
  /** 每次部署不同的版本號（前端用來發現新版） */
  CF_VERSION?: WorkerVersionMetadata;
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
  /** 寫旅遊日記用的模型（比較會寫長文、照格式；一天一篇，額度跟聊天分開） */
  GEMINI_WRITER_MODEL?: string;
  GEMINI_RPM?: string;
  GEMINI_TPM?: string;
  GEMINI_RPD?: string;
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
    /** 最多輸出幾個 token（目前只有 Workers AI 需要，預設 2048） */
    maxTokens?: number;
    /** Gemini 整段回應的時限（預設 45 秒；寫長文的模型要久一點） */
    timeoutMs?: number;
  }): Promise<GenerateResult>;
}
