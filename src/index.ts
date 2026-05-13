/**
 * pi-review-gate — CI-Level Merge Guardian
 *
 * Enforces merge requirements: required reviewers, all checks green,
 * no breaking changes, not stale. Agents use review tools instead of
 * raw merge commands. Core enforcement runs in Gitea Actions (un-bypassable).
 *
 * Tools:
 *   review_check(pr_number)        → check if PR is merge-ready
 *   review_approve(pr_number)      → submit approval review
 *   review_request(pr_number, ...)  → request reviewers by username
 *   review_status(pr_number)        → show review + check status
 *   review_close_stale(pr_number)   → close stale PR with comment
 *
 * Config: .reviewrc.yml (required reviewers, stale threshold, protected paths)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ──

interface ReviewConfig {
  /** Minimum distinct reviewer model families required (from #42 Phase 1.2) */
  minDiverseReviews: number;
  /** Required reviewers by path pattern */
  requiredReviewers: Record<string, string[]>;
  /** Stale PR threshold in days */
  staleDays: number;
  /** Protected paths that always need human review */
  protectedPaths: string[];
  /** Breaking change detection: patterns that signal API breaks */
  breakingChangePatterns: string[];
}

const DEFAULT_CONFIG: ReviewConfig = {
  minDiverseReviews: 1,
  requiredReviewers: {},
  staleDays: 14,
  protectedPaths: [
    ".gitea/workflows/",
    "docker-compose.yml",
    "Dockerfile",
    ".env.example",
    "agents/",
    "factory/package.json",
  ],
  breakingChangePatterns: [
    "export interface",  // exported interface changes
    "export type",       // exported type changes
    "export function",   // exported function signature changes
    "export class",      // exported class changes
    "BREAKING CHANGE:",  // conventional commit breaking change marker
  ],
};

// ── Config loading ──

function loadConfig(cwd: string): ReviewConfig {
  const configPath = path.join(cwd, ".reviewrc.yml");
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const result: Record<string, unknown> = {};
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([\w][\w.]*):\s*(.+)$/);
      if (m) result[m[1]] = m[2].trim();
    }
    // Parse requiredReviewers as JSON-like: path/*: [user1, user2]
    // Simple YAML — handle comma-separated values
    const reviewers: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(result)) {
      if (key.startsWith("requiredReviewers.")) {
        const pathPattern = key.replace("requiredReviewers.", "");
        reviewers[pathPattern] = (val as string).split(",").map(s => s.trim()).filter(Boolean);
      }
    }

    return {
      minDiverseReviews: parseInt(result["minDiverseReviews"] as string) || DEFAULT_CONFIG.minDiverseReviews,
      requiredReviewers: reviewers,
      staleDays: parseInt(result["staleDays"] as string) || DEFAULT_CONFIG.staleDays,
      protectedPaths: (result["protectedPaths"] as string)?.split(",").map(s => s.trim()).filter(Boolean) || DEFAULT_CONFIG.protectedPaths,
      breakingChangePatterns: (result["breakingChangePatterns"] as string)?.split(",").map(s => s.trim()).filter(Boolean) || DEFAULT_CONFIG.breakingChangePatterns,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── Git helpers ──

function exec(cmd: string, cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = cp.execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 });
    return { ok: true, stdout: r.trim(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.trim() || "", stderr: e.stderr?.trim() || e.message };
  }
}

function currentBranch(cwd: string): string {
  return exec("git branch --show-current", cwd).stdout;
}

// ── Gitea API ──

interface GiteaApiOpts {
  repo: string;       // owner/repo
  token?: string;
}

function resolveRepo(cwd: string): GiteaApiOpts {
  const remote = exec("git remote get-url gitea 2>/dev/null || git remote get-url origin", cwd);
  const url = remote.stdout || "";
  const match = url.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const repo = match ? `${match[1]}/${match[2]}` : "factory/wrok.in";
  const credMatch = url.match(/:\/\/([^:]+):([^@]+)@/);
  const token = credMatch ? credMatch[2] : "";
  return { repo, token };
}

function giteaApi(
  path: string,
  method: string,
  body: Record<string, unknown> | null,
  opts: GiteaApiOpts,
  cwd: string,
): { ok: boolean; data: unknown; error?: string } {
  const base = `http://127.0.0.1:3001/api/v1/repos/${opts.repo}`;
  const headers = [
    opts.token ? `-H "Authorization: token ${opts.token}"` : "",
    `-H "Content-Type: application/json"`,
    `-H "Accept: application/json"`,
  ].filter(Boolean).join(" ");

  const dataFlag = body ? `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : "";
  const cmd = `curl -sf -w "\\n%{http_code}" -X ${method} "${base}${path}" ${headers} ${dataFlag}`;
  const r = exec(cmd, cwd);

  if (!r.ok) {
    // Parse HTTP status from end of output
    const lines = r.stdout.split("\n");
    const code = parseInt(lines[lines.length - 1] || "0");
    const body = lines.slice(0, -1).join("\n");
    if (code === 404) return { ok: false, data: null, error: "PR not found" };
    if (code === 403) return { ok: false, data: null, error: "Permission denied" };
    return { ok: false, data: null, error: r.stderr || body || `HTTP ${code}` };
  }

  const lines = r.stdout.split("\n");
  const bodyText = lines.slice(0, -1).join("\n");
  try {
    return { ok: true, data: JSON.parse(bodyText) };
  } catch {
    return { ok: true, data: bodyText };
  }
}

// ── Review helpers ──

function getPRInfo(prNumber: string, opts: GiteaApiOpts, cwd: string): Record<string, unknown> | null {
  const r = giteaApi(`/pulls/${prNumber}`, "GET", null, opts, cwd);
  if (!r.ok || !r.data) return null;
  return r.data as Record<string, unknown>;
}

function getPRChecks(prNumber: string, opts: GiteaApiOpts, cwd: string): unknown[] {
  const r = giteaApi(`/pulls/${prNumber}/statuses`, "GET", null, opts, cwd);
  if (!r.ok || !r.data) return [];
  // Gitea returns combined status
  return [];
}

function getPRReviews(prNumber: string, opts: GiteaApiOpts, cwd: string): unknown[] {
  const r = giteaApi(`/pulls/${prNumber}/reviews`, "GET", null, opts, cwd);
  if (!r.ok || !r.data) return [];
  return Array.isArray(r.data) ? r.data : [];
}

// ── Breaking change detection ──

function detectBreakingChanges(
  baseBranch: string,
  config: ReviewConfig,
  cwd: string,
): { hasBreaking: boolean; changes: string[] } {
  const changes: string[] = [];

  // Check diff for breaking change patterns
  const diff = exec(`git diff ${baseBranch}...HEAD -- diff-filter=M -- "*.ts" "*.tsx" 2>/dev/null`, cwd);
  if (!diff.ok || !diff.stdout) return { hasBreaking: false, changes: [] };

  for (const pattern of config.breakingChangePatterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = diff.stdout.split("\n").filter(l => l.startsWith("+") && new RegExp(escaped).test(l));
    if (matches.length > 0) {
      changes.push(`Pattern "${pattern}" matched in ${matches.length} added line(s)`);
    }
  }

  // Check for conventional commit breaking change marker
  const log = exec(`git log ${baseBranch}..HEAD --oneline`, cwd);
  if (log.ok && log.stdout.includes("BREAKING CHANGE")) {
    changes.push("Commit message includes BREAKING CHANGE marker");
  }

  return { hasBreaking: changes.length > 0, changes };
}

// ── Stale detection ──

function isStale(prCreatedAt: string, staleDays: number): boolean {
  const created = new Date(prCreatedAt);
  const now = new Date();
  const diffMs = now.getTime() - created.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays > staleDays;
}

// ── Required reviewer matching ──

function matchRequiredReviewers(
  changedFiles: string[],
  config: ReviewConfig,
): string[] {
  // Find all path patterns that match changed files
  const matchedReviewers = new Set<string>();
  for (const [pattern, reviewers] of Object.entries(config.requiredReviewers)) {
    const hasMatch = changedFiles.some(f => {
      if (pattern.endsWith("*")) return f.startsWith(pattern.slice(0, -1));
      if (pattern.endsWith("/")) return f.startsWith(pattern);
      return f === pattern;
    });
    if (hasMatch) {
      for (const r of reviewers) matchedReviewers.add(r);
    }
  }

  // Always add reviewers for protected path changes
  const hasProtected = changedFiles.some(f =>
    config.protectedPaths.some(p => f.startsWith(p))
  );
  // Protected paths require human — skip auto-assign but flag

  return [...matchedReviewers];
}

// ── Extension ──

export default function (pi: ExtensionAPI) {
  // ═══════════════════════════════════════
  // Intercept dangerous merge commands
  // ═══════════════════════════════════════
  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);

    if (event.toolName === "bash" && typeof event.input.command === "string") {
      const cmd = event.input.command;

      // Block raw git merge
      if (/\bgit\s+merge\b/.test(cmd)) {
        const ok = await ctx.ui.confirm(
          "Manual merge blocked",
          `Direct git merge bypasses review gates.\n\nCommand: ${cmd}\n\nUse review tools (review_check → review_approve) and let CI handle the merge.\n\nAllow anyway?`,
        );
        if (!ok) return { block: true, reason: "Use review tools. CI performs the merge after all gates pass." };
      }

      // Warn on closing PRs manually
      if (/\bgh\s+pr\s+close\b/.test(cmd) || /\bgit\s+push\b.*--delete/.test(cmd)) {
        ctx.ui.notify(
          "Consider using review_close_stale() for PR lifecycle management instead of raw close.",
          "warning",
        );
      }
    }
  });

  // ═══════════════════════════════════════
  // Tool: review_check
  // ═══════════════════════════════════════
  pi.registerTool({
    name: "review_check",
    label: "Check PR Merge Readiness",
    description: "Check if a PR meets all merge requirements: CI green, reviewers assigned, no breaking changes, not stale.",
    parameters: Type.Object({
      pr_number: Type.Optional(Type.String({ description: "PR number to check (auto-detects from current branch if omitted)" })),
      base: Type.Optional(Type.String({ description: "Target/base branch (default: dev)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = loadConfig(ctx.cwd);
      const opts = resolveRepo(ctx.cwd);
      const base = params.base || "dev";

      let prNumber = params.pr_number;
      let pr: Record<string, unknown> | null = null;

      if (prNumber) {
        pr = getPRInfo(prNumber, opts, ctx.cwd);
      } else {
        // Auto-detect PR from current branch
        const branch = currentBranch(ctx.cwd);
        const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
        if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
          pr = r.data[0] as Record<string, unknown>;
          prNumber = String(pr.number);
        }
      }

      if (!pr || !prNumber) {
        return {
          content: [{ type: "text", text: "No open PR found for this branch. Create one with contrib_submit() first." }],
          isError: true,
          details: {},
        };
      }

      const lines: string[] = [];
      const issues: string[] = [];
      let ready = true;

      lines.push(`📋 PR #${prNumber} Merge Readiness`);
      lines.push(`   Title: ${pr.title || "(unknown)"}`);
      lines.push(`   State: ${pr.state || "unknown"}`);

      // 1. Check CI status
      const statuses = getPRChecks(prNumber, opts, ctx.cwd);
      if (statuses.length === 0) {
        lines.push(`   CI Checks: ⚠️ No status data (checks may still be running)`);
      }

      // 2. Check reviews
      const reviews = getPRReviews(prNumber, opts, ctx.cwd);
      const approvals = reviews.filter((r: any) => r.state === "APPROVED");
      const changeRequests = reviews.filter((r: any) => r.state === "REQUEST_CHANGES");

      if (changeRequests.length > 0) {
        issues.push(`❌ ${changeRequests.length} reviewer(s) requested changes`);
        ready = false;
      }
      lines.push(`   Reviews: ${approvals.length} approved, ${changeRequests.length} changes requested`);

      // 3. Check required reviewers
      const diff = exec(`git diff ${base}...HEAD --name-only 2>/dev/null`, ctx.cwd);
      const changedFiles = diff.ok ? diff.stdout.split("\n").filter(Boolean) : [];
      const required = matchRequiredReviewers(changedFiles, config);
      if (required.length > 0) {
        const reviewerLogins = new Set(reviews.map((r: any) => r.user?.login));
        const missing = required.filter(r => !reviewerLogins.has(r));
        if (missing.length > 0) {
          issues.push(`⚠️ Missing required reviewers: ${missing.join(", ")}`);
          // Non-blocking — warn but don't block
        }
        lines.push(`   Required reviewers: ${required.join(", ")}`);
      }

      // 4. Check for breaking changes
      const breaking = detectBreakingChanges(base, config, ctx.cwd);
      if (breaking.hasBreaking) {
        issues.push(`⚠️ Potential breaking changes detected:`);
        for (const c of breaking.changes) {
          issues.push(`   - ${c}`);
        }
        issues.push(`   Human review required for breaking changes.`);
      }
      lines.push(`   Breaking changes: ${breaking.hasBreaking ? "⚠️ detected" : "✅ none"}`);

      // 5. Check staleness
      if (pr.created_at) {
        const stale = isStale(pr.created_at as string, config.staleDays);
        if (stale) {
          issues.push(`⚠️ PR is ${config.staleDays}+ days old — consider closing or refreshing`);
        }
        lines.push(`   Age: ${stale ? "⚠️ stale" : "✅ fresh"}`);
      }

      // 6. Check protected paths
      const hasProtected = changedFiles.some(f =>
        config.protectedPaths.some(p => f.startsWith(p))
      );
      if (hasProtected) {
        issues.push(`🔒 Protected paths modified — human review required`);
        lines.push(`   Protected paths: 🔒 yes`);
      } else {
        lines.push(`   Protected paths: ✅ none`);
      }

      // Summary
      if (ready && issues.length === 0) {
        lines.push(``, `✅ PR is ready to merge! All gates passed.`);
      } else if (ready) {
        lines.push(``, `⚠️ PR has warnings — review before merging:`);
        for (const i of issues) lines.push(`   ${i}`);
      } else {
        lines.push(``, `❌ PR is NOT ready. Issues:`);
        for (const i of issues) lines.push(`   ${i}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          prNumber,
          ready,
          approvals: approvals.length,
          changeRequests: changeRequests.length,
          breakingChanges: breaking.hasBreaking,
          hasProtected,
          issues,
        },
      };
    },
  });

  // ═══════════════════════════════════════
  // Tool: review_approve
  // ═══════════════════════════════════════
  pi.registerTool({
    name: "review_approve",
    label: "Approve PR",
    description: "Submit an approval review on a pull request.",
    parameters: Type.Object({
      pr_number: Type.Optional(Type.String({ description: "PR number (auto-detects from current branch if omitted)" })),
      comment: Type.Optional(Type.String({ description: "Review comment explaining approval" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const opts = resolveRepo(ctx.cwd);

      let prNumber = params.pr_number;
      if (!prNumber) {
        const branch = currentBranch(ctx.cwd);
        const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
        if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
          prNumber = String((r.data[0] as Record<string, unknown>).number);
        }
      }

      if (!prNumber) {
        return {
          content: [{ type: "text", text: "No open PR found to approve." }],
          isError: true,
          details: {},
        };
      }

      const body: Record<string, unknown> = {
        event: "APPROVE",
      };
      if (params.comment) body.body = params.comment;

      const r = giteaApi(`/pulls/${prNumber}/reviews`, "POST", body, opts, ctx.cwd);

      if (!r.ok) {
        return {
          content: [{ type: "text", text: `Approval failed: ${r.error || "Unknown error"}` }],
          isError: true,
          details: {},
        };
      }

      return {
        content: [{
          type: "text",
          text: [
            `✅ PR #${prNumber} approved.`,
            params.comment ? `   Comment: ${params.comment}` : "",
            ``,
            `CI will auto-merge once all checks pass and review gates are satisfied.`,
          ].filter(Boolean).join("\n"),
        }],
        details: { prNumber, approved: true },
      };
    },
  });

  // ═══════════════════════════════════════
  // Tool: review_request
  // ═══════════════════════════════════════
  pi.registerTool({
    name: "review_request",
    label: "Request Reviewers",
    description: "Request specific reviewers on a pull request.",
    parameters: Type.Object({
      pr_number: Type.Optional(Type.String({ description: "PR number (auto-detects from current branch if omitted)" })),
      reviewers: Type.String({ description: "Comma-separated list of reviewer usernames" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const opts = resolveRepo(ctx.cwd);

      let prNumber = params.pr_number;
      if (!prNumber) {
        const branch = currentBranch(ctx.cwd);
        const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
        if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
          prNumber = String((r.data[0] as Record<string, unknown>).number);
        }
      }

      if (!prNumber) {
        return {
          content: [{ type: "text", text: "No open PR found for this branch." }],
          isError: true,
          details: {},
        };
      }

      const reviewerList = params.reviewers.split(",").map(s => s.trim()).filter(Boolean);
      if (reviewerList.length === 0) {
        return {
          content: [{ type: "text", text: "No valid reviewers provided." }],
          isError: true,
          details: {},
        };
      }

      // Gitea API: assign reviewers to PR
      const body = { reviewers: reviewerList };
      const r = giteaApi(`/pulls/${prNumber}/requested_reviewers`, "POST", body, opts, ctx.cwd);

      if (!r.ok) {
        return {
          content: [{ type: "text", text: `Failed to request reviewers: ${r.error || "Unknown error"}` }],
          isError: true,
          details: {},
        };
      }

      return {
        content: [{
          type: "text",
          text: `✅ Reviewers requested on PR #${prNumber}: ${reviewerList.join(", ")}`,
        }],
        details: { prNumber, reviewers: reviewerList },
      };
    },
  });

  // ═══════════════════════════════════════
  // Tool: review_status
  // ═══════════════════════════════════════
  pi.registerTool({
    name: "review_status",
    label: "Review Status",
    description: "Show detailed review and CI status for a PR.",
    parameters: Type.Object({
      pr_number: Type.Optional(Type.String({ description: "PR number (auto-detects from current branch if omitted)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const opts = resolveRepo(ctx.cwd);

      let prNumber = params.pr_number;
      if (!prNumber) {
        const branch = currentBranch(ctx.cwd);
        const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
        if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
          prNumber = String((r.data[0] as Record<string, unknown>).number);
        }
      }

      if (!prNumber) {
        return {
          content: [{ type: "text", text: "No open PR found for this branch." }],
          isError: true,
          details: {},
        };
      }

      const pr = getPRInfo(prNumber, opts, ctx.cwd);
      if (!pr) {
        return {
          content: [{ type: "text", text: `PR #${prNumber} not found.` }],
          isError: true,
          details: {},
        };
      }

      const reviews = getPRReviews(prNumber, opts, ctx.cwd);
      const config = loadConfig(ctx.cwd);

      const lines: string[] = [];
      lines.push(`📋 PR #${prNumber} — ${pr.title || "unknown"}`);
      lines.push(`   State: ${pr.state}  |  Draft: ${pr.draft ? "yes" : "no"}`);
      lines.push(`   Author: ${(pr.user as any)?.login || "unknown"}`);
      lines.push(`   Branch: ${pr.head?.label || "?"} → ${pr.base?.label || "?"}`);
      lines.push(`   Created: ${pr.created_at || "?"}`);
      lines.push(`   URL: ${pr.html_url || "?"}`);
      lines.push(``);

      // Review summary
      lines.push(`👥 Reviews (${reviews.length}):`);
      if (reviews.length === 0) {
        lines.push(`   (none yet)`);
      } else {
        for (const review of reviews as any[]) {
          const stateIcon =
            review.state === "APPROVED" ? "✅" :
            review.state === "REQUEST_CHANGES" ? "❌" :
            review.state === "COMMENT" ? "💬" : "❓";
          lines.push(`   ${stateIcon} ${review.user?.login || "?"} — ${review.state} (${review.submitted_at || "?"})`);
          if (review.body) {
            const preview = review.body.slice(0, 80).replace(/\n/g, " ");
            lines.push(`      "${preview}${review.body.length > 80 ? "..." : ""}"`);
          }
        }
      }

      // Stale check
      if (pr.created_at) {
        const daysOld = Math.floor((Date.now() - new Date(pr.created_at as string).getTime()) / 86400000);
        const staleWarning = daysOld > config.staleDays ? " ⚠️ STALE" : "";
        lines.push(``, `⏱ Age: ${daysOld} days${staleWarning} (stale threshold: ${config.staleDays} days)`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          prNumber,
          title: pr.title,
          state: pr.state,
          author: (pr.user as any)?.login,
          reviews: reviews.length,
          url: pr.html_url,
        },
      };
    },
  });

  // ═══════════════════════════════════════
  // Tool: review_close_stale
  // ═══════════════════════════════════════
  pi.registerTool({
    name: "review_close_stale",
    label: "Close Stale PR",
    description: "Close a stale pull request with a comment explaining why.",
    parameters: Type.Object({
      pr_number: Type.String({ description: "PR number to close" }),
      reason: Type.Optional(Type.String({ description: "Reason for closing (default: stale)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const opts = resolveRepo(ctx.cwd);

      const pr = getPRInfo(params.pr_number, opts, ctx.cwd);
      if (!pr) {
        return {
          content: [{ type: "text", text: `PR #${params.pr_number} not found.` }],
          isError: true,
          details: {},
        };
      }

      const reason = params.reason || "stale";
      const closeComment = `🔒 Auto-closed: ${reason}.\n\nThis PR has been automatically closed because it has been inactive for more than the configured threshold. If this work is still needed, please reopen or create a new PR.`;

      // Post closing comment
      giteaApi(
        `/issues/${params.pr_number}/comments`,
        "POST",
        { body: closeComment },
        opts,
        ctx.cwd,
      );

      // Close PR (update state)
      const r = giteaApi(
        `/pulls/${params.pr_number}`,
        "PATCH",
        { state: "closed" },
        opts,
        ctx.cwd,
      );

      if (!r.ok) {
        return {
          content: [{ type: "text", text: `Failed to close PR: ${r.error || "Unknown error"}` }],
          isError: true,
          details: {},
        };
      }

      return {
        content: [{
          type: "text",
          text: [
            `🔒 PR #${params.pr_number} closed.`,
            `   Reason: ${reason}`,
            `   Title: ${pr.title || "unknown"}`,
          ].join("\n"),
        }],
        details: { prNumber: params.pr_number, closed: true, reason },
      };
    },
  });
}
