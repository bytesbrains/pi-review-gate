# Review Gate — Agent Usage Guide

> You are an AI agent. Use review-gate tools for all PR review and merge operations. Never call `git merge` directly.

## Golden Rule

> **⚠️ DO NOT call `git merge`, `gh pr merge`, or close PRs directly.**
> Use `review_check()` → `review_approve()` and let CI handle the merge.
> CI enforces all gates: required reviewers, breaking change detection, and conventional commit squash.

## Workflow for Reviewing a PR

```
review_check(pr_number="51")        ← check merge readiness
  │
  ▼
[CI green? Reviews in? No breaking changes? Not stale?]
  │
  ▼
review_approve(pr_number="51",      ← submit your approval
  comment="LGTM — all gates pass")
  │
  ▼
[CI detects approval + gates pass → auto-merge]
```

## Workflow for Closing Stale PRs

```
review_status(pr_number="23")       ← check PR age
  │
  ▼
review_close_stale(pr_number="23",  ← close with reason
  reason="14+ days inactive")
```

## Requesting Reviews

```
review_request(pr_number="51",
  reviewers="alice,bob")
```

## Understanding review_check Output

```
📋 PR #51 Merge Readiness
   Title: feat(backup): add Firebase volume backup
   State: open
   CI Checks: ✅ all green
   Reviews: 1 approved, 0 changes requested
   Required reviewers: alice ✅
   Breaking changes: ✅ none
   Age: ✅ fresh (2 days)
   Protected paths: ✅ none

✅ PR is ready to merge! All gates passed.
```

## When Things Go Wrong

| Problem | Solution |
|---|---|
| CI failed | Check CI logs, fix issues, push update |
| Changes requested | Address reviewer feedback, push fixes, re-request review |
| Breaking changes detected | Add BREAKING CHANGE to commit body, flag for human review |
| Missing required reviewers | Use `review_request()` to assign path-required reviewers |
| PR is stale | Either close with `review_close_stale()` or push an update to refresh |

## Configuration Reference

`.reviewrc.yml` controls review behavior:

```yaml
staleDays: 14                    # days before PR is considered stale
minDiverseReviews: 1             # minimum different model families that must review
requiredReviewers.agents/**: agent-owner   # path → reviewer mapping
protectedPaths: .gitea/workflows/,agents/   # paths needing human review
breakingChangePatterns: export interface,export type,BREAKING CHANGE:
```
