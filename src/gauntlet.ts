import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { GauntletFinding, GauntletResult, Goal, Severity } from "./types.js";

export interface GauntletOptions {
  round: number;
  runTests: boolean;
  testCommand?: string;
  worktreeRoot?: string;
}

let findingSeq = 0;
const fid = () => `F${++findingSeq}-${Date.now().toString(36)}`;

function mk(
  goalId: string,
  title: string,
  evidence: string,
  severity: Severity,
  requiredRemediation: string,
  category: string
): GauntletFinding {
  return { id: fid(), goalId, title, evidence, severity, requiredRemediation, category, status: "open", at: new Date().toISOString() };
}

function listFiles(root: string, exts: Set<string>, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".git" || e === ".cortex" || e === "dist" || e === ".swarm") continue;
    const p = join(root, e);
    try {
      const st = statSync(p);
      if (st.isDirectory()) listFiles(p, exts, out, depth + 1);
      else if (exts.has(extname(p))) out.push(p);
    } catch { /* ignore */ }
  }
  return out;
}

/** Generic-design tell scanner (§15): concrete patterns of AI-templated UI. */
const GENERIC_TELLS: Array<{ name: string; re: RegExp; why: string }> = [
  { name: "cream+serif+terracotta", re: /#f[ae][a-f0-9]{4}.*(serif|georgia|playfair)|terracotta|#c96f4a|#e2725b/i, why: "warm cream + serif + terracotta default palette" },
  { name: "neon-on-black", re: /#0{3,6}.*#(00ff| lime|cyan|#39ff)/i, why: "near-black + single neon accent default" },
  { name: "eyebrow-labels", re: /letter-spacing:\s*0\.2em|text-transform:\s*uppercase.{0,80}(eyebrow|label)/i, why: "tracked-out ALL-CAPS eyebrow labels" },
  { name: "middle-dot-meta", re: /·.*·|&middot;.*&middot;/, why: "meta strings joined with middle dots" },
  { name: "numbered-nonsequence", re: /0[123][^0-9].{0,40}(feature|card|item)/i, why: "01/02/03 markers on non-sequential content" },
  { name: "single-word-accent", re: /<em>([A-Za-z]+)<\/em>|<span class="[^"]*accent[^"]*">[A-Za-z]+<\/span>/, why: "single-word headline accent as default emphasis" },
  { name: "fade-slide-everywhere", re: /fade[-_ ]?up|@keyframes\s+fadeUp/i, why: "fade-and-slide-up entrance used decoratively" },
];

export function scanGenericDesign(projectRoot: string, goalId: string): GauntletFinding[] {
  const findings: GauntletFinding[] = [];
  const files = listFiles(resolve(projectRoot), new Set([".css", ".scss", ".html", ".tsx", ".jsx", ".vue"]));
  for (const f of files.slice(0, 60)) {
    let src = "";
    try {
      src = readFileSync(f, "utf8");
    } catch { continue; }
    for (const tell of GENERIC_TELLS) {
      if (tell.re.test(src)) {
        findings.push(
          mk(goalId, `Generic-design tell: ${tell.name}`, `${relative(projectRoot, f)} matches ${tell.name} — ${tell.why}`, "medium", "Ground palette/typography/layout in the subject matter; revise per design-token plan before shipping.", "ux-genericness")
        );
        break; // one finding per file keeps signal tight
      }
    }
  }
  return findings;
}

export function scanAccessibility(projectRoot: string, goalId: string): GauntletFinding[] {
  const findings: GauntletFinding[] = [];
  const files = listFiles(resolve(projectRoot), new Set([".html", ".tsx", ".jsx", ".vue"]));
  for (const f of files.slice(0, 60)) {
    let src = "";
    try {
      src = readFileSync(f, "utf8");
    } catch { continue; }
    const rel = relative(projectRoot, f);
    const imgs = src.match(/<img\b[^>]*>/g) ?? [];
    if (imgs.some((t) => !/alt=/.test(t))) {
      findings.push(mk(goalId, "Images missing alt text", `${rel}: <img> without alt attribute`, "medium", "Add meaningful alt text to all images.", "accessibility"));
    }
    const inputs = src.match(/<input\b[^>]*>/g) ?? [];
    if (inputs.some((t) => !/aria-label=|id=/.test(t)) && !/<label/.test(src)) {
      findings.push(mk(goalId, "Unlabeled form inputs", `${rel}: <input> without label association`, "medium", "Associate every input with a <label> or aria-label.", "accessibility"));
    }
    if (/<button/.test(src) && !/focus/.test(src)) {
      findings.push(mk(goalId, "No visible focus styling", `${rel}: buttons present but no :focus styling found`, "low", "Add visible keyboard-focus styles.", "accessibility"));
    }
  }
  return findings;
}

export function scanResponsiveBasis(projectRoot: string, goalId: string): GauntletFinding[] {
  const findings: GauntletFinding[] = [];
  const files = listFiles(resolve(projectRoot), new Set([".html"]));
  for (const f of files.slice(0, 20)) {
    let src = "";
    try {
      src = readFileSync(f, "utf8");
    } catch { continue; }
    if (!/name="viewport"/.test(src)) {
      findings.push(mk(goalId, "Missing viewport meta", `${relative(projectRoot, f)} has no viewport meta tag`, "high", "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.", "responsiveness"));
    }
  }
  const css = listFiles(resolve(projectRoot), new Set([".css", ".scss"]));
  let hasMedia = false;
  for (const f of css.slice(0, 30)) {
    try {
      if (/@media/.test(readFileSync(f, "utf8"))) { hasMedia = true; break; }
    } catch { /* ignore */ }
  }
  if (css.length > 0 && !hasMedia) {
    findings.push(mk(goalId, "No responsive breakpoints", "CSS present but no @media queries found", "medium", "Add breakpoints covering 375px / 768px / 1440px.", "responsiveness"));
  }
  return findings;
}

export function scanSecurityBasics(projectRoot: string, goalId: string): GauntletFinding[] {
  const findings: GauntletFinding[] = [];
  const files = listFiles(resolve(projectRoot), new Set([".ts", ".js", ".mjs", ".py", ".go", ".rs"]));
  const pats: Array<{ re: RegExp; title: string; fix: string; sev: Severity }> = [
    { re: /eval\s*\(/, title: "Use of eval()", fix: "Remove eval(); use structured parsing instead.", sev: "high" },
    { re: /innerHTML\s*=/, title: "innerHTML assignment (XSS surface)", fix: "Use textContent or a sanitizer.", sev: "medium" },
    { re: /password\s*=\s*["'][^"']+["']/, title: "Hard-coded password", fix: "Move credentials to environment / secret store.", sev: "critical" },
    { re: /Math\.random\(\)[^\n]*token|token[^\n]*Math\.random\(\)/i, title: "Insecure token generation", fix: "Use crypto random primitives.", sev: "high" },
  ];
  for (const f of files.slice(0, 80)) {
    let src = "";
    try {
      src = readFileSync(f, "utf8");
    } catch { continue; }
    for (const p of pats) {
      if (p.re.test(src)) {
        findings.push(mk(goalId, p.title, `${relative(projectRoot, f)} matches ${p.re}`, p.sev, p.fix, "security"));
      }
    }
  }
  return findings;
}

function runTestCommand(projectRoot: string, cmd: string): { passed: boolean; output: string } {
  try {
    const out = execSync(cmd, { cwd: resolve(projectRoot), timeout: 120000, stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { passed: true, output: out.slice(-2000) };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const output = [err.stdout?.toString() ?? "", err.stderr?.toString() ?? "", err.message ?? ""].join("\n").slice(-2000);
    return { passed: false, output };
  }
}

function detectTestCommand(projectRoot: string): string | null {
  const pkg = join(resolve(projectRoot), "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
      if (j.scripts?.test) return "npm test --silent";
    } catch { /* ignore */ }
  }
  if (existsSync(join(resolve(projectRoot), "pytest.ini")) || existsSync(join(resolve(projectRoot), "pyproject.toml"))) return "pytest -q";
  if (existsSync(join(resolve(projectRoot), "go.mod"))) return "go test ./...";
  if (existsSync(join(resolve(projectRoot), "Cargo.toml"))) return "cargo test --quiet";
  return null;
}

/**
 * Adversarial verification pass (§15). Inspects requirements/tests/
 * architecture/edge cases/security/performance/UX/a11y/integration — and
 * produces evidenced findings, never vibes.
 */
export function runGauntlet(
  projectRoot: string,
  goals: Goal[],
  opts: GauntletOptions
): GauntletResult {
  const findings: GauntletFinding[] = [];
  const uiGoals = goals.filter((g) => /responsive|accessib|visual|ux|implement/i.test(g.description));
  const anchor = uiGoals[0]?.id ?? goals[0]?.id ?? "G-unknown";

  // 1. Tests: run the real suite when asked and available.
  if (opts.runTests) {
    const cmd = opts.testCommand ?? detectTestCommand(projectRoot);
    if (cmd) {
      const r = runTestCommand(projectRoot, cmd);
      if (!r.passed) {
        const testGoal = goals.find((g) => /test/i.test(g.description))?.id ?? anchor;
        findings.push(mk(testGoal, "Test suite fails", r.output || "test command exited non-zero", "high", "Fix failing tests; do not re-run unchanged.", "tests"));
      }
    }
  }

  // 2. Requirements: every goal must have success criteria + evidence.
  for (const g of goals) {
    if (g.status === "abandoned") continue;
    if (g.successCriteria.length === 0) {
      findings.push(mk(g.id, "Goal has no success criteria", `goal ${g.id} defines no measurable bar`, "high", "Add measurable success criteria before claiming completion.", "requirements"));
    }
    if ((g.status === "in_review" || g.status === "in_progress") && g.evidence.length === 0) {
      findings.push(mk(g.id, "Goal claims progress without evidence", `goal ${g.id} (${g.status}) has zero evidence entries`, "medium", "Attach evidence (tests, artifacts, observations) or mark uncertain.", "evidence"));
    }
  }

  // 3. Architecture/regression: TODO/FIXME left in touched areas.
  const codeFiles = listFiles(resolve(projectRoot), new Set([".ts", ".js", ".mjs", ".py", ".go", ".rs"]));
  for (const f of codeFiles.slice(0, 80)) {
    try {
      const src = readFileSync(f, "utf8");
      const m = src.match(/TODO|FIXME|XXX|HACK|placeholder|not implemented/i);
      if (m) {
        findings.push(mk(anchor, "Placeholder left in code", `${relative(projectRoot, f)} contains "${m[0]}"`, "medium", "Finish or remove the placeholder; placeholders are not completion.", "regressions"));
        if (findings.length > 40) break;
      }
    } catch { /* ignore */ }
  }

  // 4. Security basics.
  findings.push(...scanSecurityBasics(projectRoot, anchor));

  // 5. UI/UX track for UI-touching goals.
  const touchesUI = goals.some((g) => /responsive|accessib|visual|ux|frontend|ui\b/i.test(g.description));
  if (touchesUI) {
    findings.push(...scanResponsiveBasis(projectRoot, anchor));
    findings.push(...scanAccessibility(projectRoot, anchor));
    findings.push(...scanGenericDesign(projectRoot, anchor));
  }

  const openByGoal = new Map<string, GauntletFinding[]>();
  for (const f of findings) {
    const l = openByGoal.get(f.goalId) ?? [];
    l.push(f);
    openByGoal.set(f.goalId, l);
  }
  const goalVerdicts = goals.map((g) => ({
    goalId: g.id,
    passed: !(openByGoal.get(g.id) ?? []).some((f) => f.severity === "critical" || f.severity === "high"),
  }));

  return {
    passed: !findings.some((f) => f.severity === "critical" || f.severity === "high"),
    goalVerdicts,
    findings,
    round: opts.round,
    at: new Date().toISOString(),
  };
}
