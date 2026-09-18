import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { busDir } from "./paths.js";
import { redactSecrets } from "./redaction.js";

/**
 * Filesystem coordination bus (§1 fallback). Native plugin IPC for
 * subagent-to-controller coordination may be absent; the bus always works:
 * workers and the controller poll and write messages, findings, and
 * dispatch signals under `.cortex/bus/`.
 */

export interface BusMessage {
  id: string;
  kind: "dispatch" | "report" | "finding" | "status" | "signal";
  from: string;
  to: string;
  payload: unknown;
  at: string;
}

function ensureBus(projectRoot: string): string {
  const d = busDir(projectRoot);
  mkdirSync(d, { recursive: true });
  return d;
}

export function busWrite(projectRoot: string, msg: Omit<BusMessage, "id" | "at">): BusMessage {
  const d = ensureBus(projectRoot);
  const full: BusMessage = {
    ...msg,
    payload: JSON.parse(redactSecrets(JSON.stringify(msg.payload)).text) as unknown,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
  };
  writeFileSync(join(d, `${full.id}.json`), JSON.stringify(full, null, 2));
  return full;
}

export function busRead(
  projectRoot: string,
  filter?: { kind?: BusMessage["kind"]; to?: string; since?: string }
): BusMessage[] {
  const d = busDir(projectRoot);
  if (!existsSync(d)) return [];
  const out: BusMessage[] = [];
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(d, f), "utf8")) as BusMessage;
      if (filter?.kind && m.kind !== filter.kind) continue;
      if (filter?.to && m.to !== filter.to && m.to !== "*") continue;
      if (filter?.since && m.at < filter.since) continue;
      out.push(m);
    } catch { /* skip corrupt entries */ }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export function busClear(projectRoot: string): number {
  const d = busDir(projectRoot);
  if (!existsSync(d)) return 0;
  let n = 0;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json")) continue;
    try {
      unlinkSync(join(d, f));
      n++;
    } catch { /* ignore */ }
  }
  return n;
}
