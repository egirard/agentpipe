import { trace } from "./util.ts";

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaOpts {
  url: string;
  model: string;
  numCtx: number;
  /** JSON schema; when set the model is constrained to emit matching JSON. */
  schema?: object;
  temperature?: number;
  label?: string;
}

/** One non-streaming chat call against Ollama's native API. */
export async function ollamaChat(messages: OllamaMessage[], opts: OllamaOpts): Promise<string> {
  const body = {
    model: opts.model,
    messages,
    stream: false,
    keep_alive: "30m",
    format: opts.schema,
    options: { num_ctx: opts.numCtx, temperature: opts.temperature ?? 0.2, num_predict: 8192 },
  };
  trace(`ollama request ${opts.label ?? ""} (${opts.model})`, messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n"));
  // Bun's fetch idles out after 5 minutes by default; a 7B model on an old GPU can legitimately take longer.
  const res = await fetch(`${opts.url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45 * 60 * 1000),
    ...({ timeout: false } as object),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const content: string = data.message?.content ?? "";
  trace(`ollama response ${opts.label ?? ""}`, content + `\n[eval ${data.eval_count} tok in ${((data.eval_duration ?? 0) / 1e9).toFixed(1)}s, prompt ${data.prompt_eval_count} tok]`);
  return content;
}

/** Chat with a JSON schema and parse the result, retrying once if the model emitted junk. */
export async function ollamaJson<T>(messages: OllamaMessage[], opts: OllamaOpts & { schema: object }, validate: (v: unknown) => T): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await ollamaChat(messages, opts);
    try {
      return validate(JSON.parse(extractJson(text)));
    } catch (e) {
      lastErr = e;
      messages = [...messages, { role: "assistant", content: text }, { role: "user", content: `That was not valid JSON matching the schema (${(e as Error).message}). Reply again with only the JSON object.` }];
    }
  }
  throw new Error(`local model did not produce valid JSON: ${(lastErr as Error)?.message}`);
}

function extractJson(s: string): string {
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) return t;
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) return m[1].trim();
  const i = t.indexOf("{");
  return i >= 0 ? t.slice(i) : t;
}

export async function ollamaModels(url: string): Promise<string[]> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/tags`);
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data: any = await res.json();
  return (data.models ?? []).map((m: any) => m.name as string);
}
