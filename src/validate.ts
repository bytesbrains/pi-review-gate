import type { ReviewConfig } from "./config";
import { exec } from "./helpers";

export function detectBreakingChanges(baseBranch: string, config: ReviewConfig, cwd: string): { hasBreaking: boolean; changes: string[] } {
  const changes: string[] = [];
  const diff = exec(`git diff ${baseBranch}...HEAD --diff-filter=M -- "*.ts" "*.tsx" 2>/dev/null`, cwd);
  if (!diff.ok || !diff.stdout) return { hasBreaking: false, changes: [] };
  for (const pattern of config.breakingChangePatterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = diff.stdout.split("\n").filter(l => l.startsWith("+") && new RegExp(escaped).test(l));
    if (matches.length > 0) changes.push(`Pattern "${pattern}" matched in ${matches.length} added line(s)`);
  }
  const log = exec(`git log ${baseBranch}..HEAD --oneline`, cwd);
  if (log.ok && log.stdout.includes("BREAKING CHANGE")) changes.push("Commit message includes BREAKING CHANGE marker");
  return { hasBreaking: changes.length > 0, changes };
}

export function isStale(prCreatedAt: string, staleDays: number): boolean {
  return (Date.now() - new Date(prCreatedAt).getTime()) / 86400000 > staleDays;
}

export function matchRequiredReviewers(changedFiles: string[], config: ReviewConfig): string[] {
  const matched = new Set<string>();
  for (const [pattern, reviewers] of Object.entries(config.requiredReviewers)) {
    if (changedFiles.some(f => pattern.endsWith("*") ? f.startsWith(pattern.slice(0, -1)) : pattern.endsWith("/") ? f.startsWith(pattern) : f === pattern)) {
      for (const r of reviewers) matched.add(r);
    }
  }
  return [...matched];
}

export function parseDependencies(body: string, pattern: string): string[] {
  const deps = new Set<string>();
  let m; const re = new RegExp(pattern, "gi");
  while ((m = re.exec(body)) !== null) deps.add(m[1]);
  return [...deps];
}
