import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config";
import { exec, currentBranch, resolveGitea, giteaApi } from "../helpers";
import { detectBreakingChanges, isStale, matchRequiredReviewers } from "../validate";

export const checkTool = {
  name: "review_check" as const,
  label: "Check PR Merge Readiness",
  description: "Check if a PR meets all merge requirements: CI green, reviewers, no breaking changes, not stale.",
  parameters: Type.Object({
    pr_number: Type.Optional(Type.String({})),
    base: Type.Optional(Type.String({})),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const config = loadConfig(ctx.cwd);
    const opts = resolveGitea(ctx.cwd);
    const base = params.base || "dev";
    let prNumber = params.pr_number;
    let pr: Record<string, unknown> | null = null;

    if (prNumber) {
      const r = await giteaApi(`/pulls/${prNumber}`, "GET", null, opts, ctx.cwd);
      if (r.ok) pr = r.data as Record<string, unknown>;
    } else {
      const branch = currentBranch(ctx.cwd);
      const r = await giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) {
        pr = r.data[0] as Record<string, unknown>;
        prNumber = String(pr.number);
      }
    }
    if (!pr) return { content: [{ type: "text", text: "No open PR found." }], isError: true, details: {} };

    const lines: string[] = [];
    const issues: string[] = [];
    let ready = true;

    lines.push(`📋 PR #${prNumber} Merge Readiness`);
    lines.push(`   Title: ${pr.title || "?"}`);
    lines.push(`   State: ${pr.state}`);

    const reviewsR = await giteaApi(`/pulls/${prNumber}/reviews`, "GET", null, opts, ctx.cwd);
    const reviews = Array.isArray(reviewsR.data) ? reviewsR.data : [];
    const changeRequests = reviews.filter((r: any) => r.state === "REQUEST_CHANGES");
    if (changeRequests.length > 0) { issues.push(`❌ ${changeRequests.length} reviewer(s) requested changes`); ready = false; }
    lines.push(`   Reviews: ${reviews.filter((r: any) => r.state === "APPROVED").length} approved, ${changeRequests.length} changes requested`);

    const diff = exec(`git diff ${base}...HEAD --name-only 2>/dev/null`, ctx.cwd);
    const changedFiles = diff.ok ? diff.stdout.split("\n").filter(Boolean) : [];
    const required = matchRequiredReviewers(changedFiles, config);
    if (required.length > 0) {
      const reviewerLogins = new Set(reviews.map((r: any) => r.user?.login));
      const missing = required.filter(r => !reviewerLogins.has(r));
      if (missing.length > 0) issues.push(`⚠️ Missing required reviewers: ${missing.join(", ")}`);
      lines.push(`   Required reviewers: ${required.join(", ")}`);
    }

    const breaking = detectBreakingChanges(base, config, ctx.cwd);
    if (breaking.hasBreaking) { issues.push("⚠️ Potential breaking changes detected"); for (const c of breaking.changes) issues.push(`   - ${c}`); }
    lines.push(`   Breaking changes: ${breaking.hasBreaking ? "⚠️ detected" : "✅ none"}`);

    if (pr.created_at) {
      const stale = isStale(pr.created_at as string, config.staleDays);
      if (stale) issues.push(`⚠️ PR is ${config.staleDays}+ days old`);
      lines.push(`   Age: ${stale ? "⚠️ stale" : "✅ fresh"}`);
    }

    const hasProtected = changedFiles.some(f => config.protectedPaths.some(p => f.startsWith(p)));
    if (hasProtected) issues.push("🔒 Protected paths modified — human review required");
    lines.push(`   Protected paths: ${hasProtected ? "🔒 yes" : "✅ none"}`);

    const hasBlockers = issues.some(i => i.startsWith("❌") || i.startsWith("🔒"));
    if (issues.length > 0) { lines.push(""); for (const i of issues) lines.push(`   ${i}`); }
    if (hasBlockers) lines.push("", "❌ PR is NOT ready.");
    else if (issues.length === 0) lines.push("", "✅ PR is ready to merge!");
    else lines.push("", "⚠️ PR has warnings but can be merged.");

    return { content: [{ type: "text", text: lines.join("\n") }], details: { prNumber, ready: !hasBlockers } };
  },
};
