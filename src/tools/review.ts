import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentBranch, resolveGitea, giteaApi } from "../helpers";

export const approveTool = {
  name: "review_approve" as const,
  label: "Approve PR",
  description: "Submit an approval review on a pull request.",
  parameters: Type.Object({
    pr_number: Type.Optional(Type.String({})),
    comment: Type.Optional(Type.String({})),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const opts = resolveGitea(ctx.cwd);
    let prNumber = params.pr_number;
    if (!prNumber) {
      const branch = currentBranch(ctx.cwd);
      const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) prNumber = String((r.data[0] as any).number);
    }
    if (!prNumber) return { content: [{ type: "text", text: "No open PR found." }], isError: true, details: {} };
    const body: Record<string, unknown> = { event: "APPROVE" };
    if (params.comment) body.body = params.comment;
    const r = giteaApi(`/pulls/${prNumber}/reviews`, "POST", body, opts, ctx.cwd);
    if (!r.ok) return { content: [{ type: "text", text: `Approval failed: ${r.error}` }], isError: true, details: {} };
    return { content: [{ type: "text", text: `✅ PR #${prNumber} approved. CI will auto-merge once all checks pass.` }], details: { prNumber } };
  },
};

export const requestTool = {
  name: "review_request" as const,
  label: "Request Reviewers",
  description: "Request specific reviewers on a pull request.",
  parameters: Type.Object({
    pr_number: Type.Optional(Type.String({})),
    reviewers: Type.String({}),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const opts = resolveGitea(ctx.cwd);
    let prNumber = params.pr_number;
    if (!prNumber) {
      const branch = currentBranch(ctx.cwd);
      const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) prNumber = String((r.data[0] as any).number);
    }
    if (!prNumber) return { content: [{ type: "text", text: "No open PR found." }], isError: true, details: {} };
    const reviewerList = params.reviewers.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (reviewerList.length === 0) return { content: [{ type: "text", text: "No valid reviewers." }], isError: true, details: {} };
    const r = giteaApi(`/pulls/${prNumber}/requested_reviewers`, "POST", { reviewers: reviewerList }, opts, ctx.cwd);
    if (!r.ok) return { content: [{ type: "text", text: `Failed: ${r.error}` }], isError: true, details: {} };
    return { content: [{ type: "text", text: `✅ Reviewers requested on PR #${prNumber}: ${reviewerList.join(", ")}` }], details: { prNumber } };
  },
};

export const statusTool = {
  name: "review_status" as const,
  label: "Review Status",
  description: "Show detailed review and CI status for a PR.",
  parameters: Type.Object({ pr_number: Type.Optional(Type.String({})) }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const opts = resolveGitea(ctx.cwd);
    let prNumber = params.pr_number;
    if (!prNumber) {
      const branch = currentBranch(ctx.cwd);
      const r = giteaApi(`/pulls?state=open&head=${branch}`, "GET", null, opts, ctx.cwd);
      if (r.ok && Array.isArray(r.data) && r.data.length > 0) prNumber = String((r.data[0] as any).number);
    }
    if (!prNumber) return { content: [{ type: "text", text: "No open PR found." }], isError: true, details: {} };
    const prR = giteaApi(`/pulls/${prNumber}`, "GET", null, opts, ctx.cwd);
    if (!prR.ok) return { content: [{ type: "text", text: `PR #${prNumber} not found.` }], isError: true, details: {} };
    const pr = prR.data as Record<string, unknown>;
    const reviewsR = giteaApi(`/pulls/${prNumber}/reviews`, "GET", null, opts, ctx.cwd);
    const reviews = Array.isArray(reviewsR.data) ? reviewsR.data : [];
    const lines = [`📋 PR #${prNumber} — ${pr.title}`, `   State: ${pr.state}  |  Draft: ${pr.draft ? "yes" : "no"}`, `   Author: ${(pr.user as any)?.login}`, `   Branch: ${(pr as any).head?.label || "?"} → ${(pr as any).base?.label || "?"}`, `   URL: ${pr.html_url}`, "", `👥 Reviews (${reviews.length}):`];
    for (const r of reviews as any[]) {
      const icon = r.state === "APPROVED" ? "✅" : r.state === "REQUEST_CHANGES" ? "❌" : "💬";
      lines.push(`   ${icon} ${r.user?.login} — ${r.state}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }], details: { prNumber } };
  },
};

export const closeStaleTool = {
  name: "review_close_stale" as const,
  label: "Close Stale PR",
  description: "Close a stale pull request with a comment.",
  parameters: Type.Object({
    pr_number: Type.String({}),
    reason: Type.Optional(Type.String({})),
  }),
  async execute(_id: string, params: any, _s: any, _u: any, ctx: ExtensionContext) {
    const opts = resolveGitea(ctx.cwd);
    const reason = params.reason || "stale";
    const prR = giteaApi(`/pulls/${params.pr_number}`, "GET", null, opts, ctx.cwd);
    if (!prR.ok) return { content: [{ type: "text", text: `PR #${params.pr_number} not found.` }], isError: true, details: {} };
    giteaApi(`/issues/${params.pr_number}/comments`, "POST", { body: `🔒 Auto-closed: ${reason}.` }, opts, ctx.cwd);
    const r = giteaApi(`/pulls/${params.pr_number}`, "PATCH", { state: "closed" }, opts, ctx.cwd);
    if (!r.ok) return { content: [{ type: "text", text: `Failed: ${r.error}` }], isError: true, details: {} };
    return { content: [{ type: "text", text: `🔒 PR #${params.pr_number} closed.` }], details: { prNumber: params.pr_number } };
  },
};
