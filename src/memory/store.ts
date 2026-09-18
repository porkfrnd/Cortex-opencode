import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry } from "../types.js";
import { sanitizeForMemory } from "../redaction.js";

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json"));
}

export class MemoryStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(e: MemoryEntry): void {
    writeFileSync(this.path(e.id), JSON.stringify(e, null, 2));
  }

  remove(id: string): void {
    try {
      unlinkSync(this.path(id));
    } catch { /* ignore */ }
  }

  write(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "uses" | "hits" | "usefulness"> & { id?: string }): MemoryEntry | null {
    const clean = sanitizeForMemory({ text: entry.text });
    if (!clean.ok) return null; // refused (.env) — never persisted
    const id = entry.id ?? `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const now = new Date().toISOString();
    const full: MemoryEntry = {
      ...entry,
      id,
      text: clean.text,
      importance: Math.max(0, Math.min(1, entry.importance)),
      usefulness: 0.5,
      uses: 0,
      hits: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.save(full);
    return full;
  }

  read(id: string): MemoryEntry | null {
    const p = this.path(id);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as MemoryEntry;
    } catch {
      return null;
    }
  }

  all(projectId?: string): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const f of files(this.dir)) {
      try {
        const e = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as MemoryEntry;
        if (projectId && e.projectId !== projectId && e.projectId !== "global") continue;
        out.push(e);
      } catch { /* skip corrupt */ }
    }
    return out;
  }

  /** Ranking: semantic overlap + project relevance + importance + recency + usefulness (§20). */
  recall(query: string, projectId: string, budgetChars: number, topN = 10): MemoryEntry[] {
    const qt = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
    const nowMs = Date.now();
    const scored = this.all(projectId).map((e) => {
      const et = new Set(e.text.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
      let overlap = 0;
      for (const w of qt) if (et.has(w)) overlap++;
      const semantic = overlap / Math.max(qt.size, 1);
      const projectBoost = e.projectId === projectId ? 0.25 : 0;
      const ageDays = Math.max(0, (nowMs - Date.parse(e.updatedAt)) / 86400000);
      const recency = Math.exp(-ageDays / 60);
      const score = semantic * 0.45 + projectBoost + e.importance * 0.2 + recency * 0.1 + e.usefulness * 0.15;
      return { e, score };
    });
    // Strict context budget: drop, never squeeze (§20, §26).
    const ranked = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topN)
      .map((s) => s.e);
    const kept: MemoryEntry[] = [];
    let used = 0;
    for (const e of ranked) {
      if (used + e.text.length > budgetChars) continue;
      kept.push(e);
      used += e.text.length;
    }
    for (const e of kept) {
      e.hits++;
      try {
        this.save(e);
      } catch { /* best-effort */ }
    }
    return kept;
  }

  recordOutcome(id: string, useful: boolean): void {
    const e = this.read(id);
    if (!e) return;
    e.uses++;
    e.usefulness = Math.max(0, Math.min(1, e.usefulness + (useful ? 0.1 : -0.15)));
    e.updatedAt = new Date().toISOString();
    this.save(e);
  }

  /** Consolidation (§22): merge true duplicates, preserve failures + provenance, surface conflicts. */
  consolidate(projectId: string): { merged: number; conflicts: string[]; kept: number } {
    const entries = this.all(projectId).filter((e) => e.projectId === projectId);
    let merged = 0;
    const conflicts: string[] = [];
    const seen = new Map<string, MemoryEntry>();
    for (const e of entries) {
      const key = e.text.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 120);
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, e);
        continue;
      }
      // Never merge away failures or contradictions silently.
      if (e.kind === "failed_approach" || prev.kind === "failed_approach") {
        conflicts.push(`kept both (failure preserved): ${prev.id} + ${e.id}`);
        continue;
      }
      if (contradicts(prev.text, e.text)) {
        conflicts.push(`conflict surfaced, both kept: ${prev.id} vs ${e.id}`);
        continue;
      }
      // Merge: keep higher importance, union provenance.
      const keep = prev.importance >= e.importance ? prev : e;
      const drop = keep === prev ? e : prev;
      keep.text = keep.text.length >= drop.text.length ? keep.text : `${keep.text} / ${drop.text}`.slice(0, 2000);
      keep.provenance = `${keep.provenance}; ${drop.provenance}`.slice(0, 500);
      keep.importance = Math.max(keep.importance, drop.importance);
      keep.updatedAt = new Date().toISOString();
      this.save(keep);
      this.remove(drop.id);
      seen.set(key, keep);
      merged++;
    }
    return { merged, conflicts, kept: seen.size };
  }

  clearProject(projectId: string): number {
    let n = 0;
    for (const e of this.all(projectId)) {
      if (e.projectId !== projectId) continue;
      this.remove(e.id);
      n++;
    }
    return n;
  }
}

function contradicts(a: string, b: string): boolean {
  const neg = /\b(not|never|don't|doesn't|isn't|can't|won't|avoid|deprecated|removed)\b/;
  const aT = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const bT = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let overlap = 0;
  for (const w of aT) if (bT.has(w)) overlap++;
  return overlap >= 3 && neg.test(a) !== neg.test(b);
}
