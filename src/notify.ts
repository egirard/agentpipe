import os from "node:os";
import type { GlobalConfig } from "./global.ts";
import { log, sh } from "./util.ts";

/**
 * Outbound notifications: a webhook (Discord, Slack, ntfy, Home Assistant and most chat tools
 * accept the body as posted) and/or a shell command. Both are off until configured in
 * ~/.config/agentpipe/agentpipe.json under "notifications". Failures are logged, never thrown.
 */
export type NotifyKind = "attention" | "failed" | "digest" | "budget" | "agent-health" | "worker";

export interface Notification {
  kind: NotifyKind;
  title: string;
  body: string;
  url?: string;
}

export async function notify(gcfg: GlobalConfig, n: Notification): Promise<void> {
  const cfg = gcfg.notifications;
  if (!cfg.events.includes(n.kind)) return;
  const text = `${n.title}\n\n${n.body}${n.url ? `\n${n.url}` : ""}`;
  if (cfg.webhook) {
    try {
      const res = await fetch(cfg.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: n.kind, title: n.title, body: n.body, url: n.url ?? null, host: os.hostname(), ts: new Date().toISOString(), text, content: text.slice(0, 1900) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log(`notify: webhook answered ${res.status}`);
    } catch (e) {
      log(`notify: webhook failed: ${(e as Error).message}`);
    }
  }
  if (cfg.command) {
    const r = await sh(cfg.command, os.homedir(), 60, { NOTIFY_KIND: n.kind, NOTIFY_TITLE: n.title, NOTIFY_BODY: n.body, NOTIFY_URL: n.url ?? "", NOTIFY_TEXT: text });
    if (!r.ok) log(`notify: command failed (${r.code}): ${r.output.trim().slice(0, 200)}`);
  }
}
