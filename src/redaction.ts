/**
 * Hard pipeline step: secret redaction applied before ANY write to memory,
 * state, bus, or evidence. Returns { text, redacted }.
 */

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "env-secret-assign", re: /(api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[^\s'"]+['"]?/gi },
  { name: "aws-key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { name: "openai-key", re: /sk-(proj-)?[A-Za-z0-9_-]{16,}/g },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9\-._~+/=]{10,}/g },
  { name: "cookie-auth", re: /(session|auth)[_-]?(token|cookie)\s*[:=]\s*[^\s;]+/gi },
  { name: "dotenv-line", re: /^(?:export\s+)?[A-Z_][A-Z0-9_]*=(.+)$/gm },
];

const ENV_FILE_RE = /(^|\/)\.env(\.|$)/;

export function redactSecrets(text: string): { text: string; redacted: string[] } {
  const hit: string[] = [];
  let out = text;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    if (p.re.test(out)) {
      hit.push(p.name);
      p.re.lastIndex = 0;
      out = out.replace(p.re, "[REDACTED]");
    }
  }
  return { text: out, redacted: hit };
}

/** Never persist .env file contents at all — refuse, don't redact. */
export function isEnvFilePath(filePath: string): boolean {
  return ENV_FILE_RE.test(filePath);
}

export function sanitizeForMemory(input: {
  text: string;
  sourcePath?: string;
}): { ok: boolean; text: string; reason?: string } {
  if (input.sourcePath && isEnvFilePath(input.sourcePath)) {
    return { ok: false, text: "", reason: "refused: .env file contents are never persisted" };
  }
  const { text } = redactSecrets(input.text);
  const trimmed = text.length > 2000 ? text.slice(0, 2000) : text;
  return { ok: true, text: trimmed };
}
