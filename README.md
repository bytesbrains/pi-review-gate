# Review Gate for Pi

[![npm version](https://img.shields.io/npm/v/@bytesbrains/pi-review-gate)](https://www.npmjs.com/package/@bytesbrains/pi-review-gate)
[![license](https://img.shields.io/npm/l/@bytesbrains/pi-review-gate)](./LICENSE)

> CI-level merge guardian for AI agents — required reviewers, breaking change detection, stale PR cleanup, and review automation. **Agents don't `git merge` — CI merges only after all gates pass.**

## Philosophy

`pi-contrib-gate` handles the *contribution* side (branch → commit → PR).
`pi-review-gate` handles the *review* side (check → approve → merge).

Core enforcement runs in Gitea Actions — agents **cannot bypass** these gates.

## Install

```bash
pi install npm:@bytesbrains/pi-review-gate
```

## Tools

| Tool | What it does |
|---|---|
| `review_check(pr_number)` | Check PR merge readiness — CI, reviewers, breaking changes, staleness |
| `review_approve(pr_number, comment)` | Submit an approval review |
| `review_request(pr_number, reviewers)` | Request reviewers by username |
| `review_status(pr_number)` | Show detailed review + CI status |
| `review_close_stale(pr_number, reason)` | Close stale PR with comment |

## Safety Intercepts

The gate **passively monitors** all `bash` tool calls and:

- ⛔ Blocks `git merge` — directs agents to use review tools instead
- ⚠️ Warns on `gh pr close` or branch deletion

## Review Gates (CI-enforced)

These run in Gitea Actions — agents cannot skip them:

| Gate | Config | Description |
|---|---|---|
| CI green | `quality.*` in .contribrc.yml | lint, test, build, doctor audit |
| Required reviewers | `requiredReviewers.*` in .reviewrc.yml | Path-based required reviewer mapping |
| Breaking change detection | `breakingChangePatterns` | API surface changes flagged for human review |
| Stale PR closure | `staleDays` | Auto-close PRs inactive past threshold |
| Protected paths | `protectedPaths` | Modifications to CI, agents, Docker → human review |
| Model diversity | `minDiverseReviews` | Different model families must review (from #42) |

## Configuration

Create `.reviewrc.yml` in your project root:

```yaml
# Required reviewers by path pattern
requiredReviewers.factory/**: factory-admin
requiredReviewers.agents/**: agent-owner
requiredReviewers..gitea/**: ci-admin

# Stale PR threshold (days)
staleDays: 14

# Minimum distinct model families that must review (0 = disabled)
minDiverseReviews: 1

# Paths that always require human review
protectedPaths: .gitea/workflows/,docker-compose.yml,Dockerfile,agents/,factory/package.json

# Patterns that signal API-breaking changes
breakingChangePatterns: export interface,export type,export function,export class,BREAKING CHANGE:
```

> Tip: Start with `staleDays: 14` and `minDiverseReviews: 0` during adoption, then tighten.

## Workflow

```
contrib_submit() from @bytesbrains/pi-contrib-gate
  │
  ▼
PR opened on Gitea
  │
  ▼
CI runs (lint, test, build, doctor audit)
  │
  ▼
review_check(pr_number)        ← agent checks readiness
  │
  ▼
review_request(pr_number, ...)  ← request specific reviewers
  │
  ▼
[reviewer approves]
  │
  ▼
review_check(pr_number)        ← re-check: all green? required reviewers satisfied?
  │
  ▼
CI auto-merges (squash)        ← only CI can merge
  │
  ▼
PR closed, branch deleted
```

## Stale PR Cleanup

PRs older than `staleDays` (default 14) are flagged. A CI scheduled job can auto-close them:

```bash
# Runs nightly in Gitea Actions
review-gate-stale.sh --repo factory/wrok.in --days 14
```

## Breaking Change Detection

Every CI run diffs against the base branch and scans for:
- `export interface` / `export type` / `export function` / `export class` additions
- `BREAKING CHANGE:` in commit messages

If detected, CI adds a `⚠️ breaking-change` label and requires human review.

## Integration with @bytesbrains/pi-contrib-gate

The two gates work together:

```
pi-contrib-gate          @bytesbrains/pi-review-gate
     │                        │
     │  contrib_start_work    │
     │  contrib_propose       │
     │  contrib_submit  ────→ PR created
     │                        │
     │                        │  review_check
     │                        │  review_request
     │                        │  review_approve
     │                        │  [CI enforcement]
     │                        │  auto-merge (squash)
```

Install both for full agent governance:

```bash
pi install npm:@bytesbrains/pi-contrib-gate
pi install npm:@bytesbrains/pi-review-gate
```

## License

MIT © [nandal](https://github.com/nandal)

---

Built and maintained by [BytesBrains](https://bytesbrains.com) — AI automation & agents, engineered to production standards.
*The model proposes, code guarantees.*
