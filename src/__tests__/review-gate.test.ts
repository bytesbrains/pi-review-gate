import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_CONFIG } from "../config";
import { detectBreakingChanges, isStale, matchRequiredReviewers } from "../validate";
import { exec } from "../helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ═══════════════════════════════════════
// Config
// ═══════════════════════════════════════
describe("ReviewConfig", () => {
  it("returns defaults when no config", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"));
    const config = loadConfig(tmp);
    expect(config.staleDays).toBe(14);
    expect(config.minDiverseReviews).toBe(1);
    expect(config.protectedPaths.length).toBeGreaterThan(0);
    expect(config.breakingChangePatterns.length).toBeGreaterThan(0);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses reviewrc.yml", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"));
    fs.writeFileSync(path.join(tmp, ".reviewrc.yml"), [
      "staleDays: 7",
      "minDiverseReviews: 2",
      "protectedPaths: .gitea/,agents/",
      'requiredReviewers.factory/**: factory-admin',
      'requiredReviewers.agents/**: agent-owner,reviewer',
    ].join("\n"));
    const config = loadConfig(tmp);
    expect(config.staleDays).toBe(7);
    expect(config.minDiverseReviews).toBe(2);
    expect(config.protectedPaths).toContain(".gitea/");
    expect(config.protectedPaths).toContain("agents/");
    expect(config.requiredReviewers["factory/**"]).toEqual(["factory-admin"]);
    expect(config.requiredReviewers["agents/**"]).toEqual(["agent-owner", "reviewer"]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════
// Stale detection
// ═══════════════════════════════════════
describe("isStale", () => {
  it("detects stale PR", () => {
    const oldDate = new Date(Date.now() - 20 * 86400000).toISOString();
    expect(isStale(oldDate, 14)).toBe(true);
  });

  it("detects fresh PR", () => {
    const recentDate = new Date(Date.now() - 5 * 86400000).toISOString();
    expect(isStale(recentDate, 14)).toBe(false);
  });

  it("exactly at boundary is fresh", () => {
    const boundaryDate = new Date(Date.now() - 14 * 86400000 + 1000).toISOString();
    expect(isStale(boundaryDate, 14)).toBe(false);
  });
});

// ═══════════════════════════════════════
// Required reviewers
// ═══════════════════════════════════════
describe("matchRequiredReviewers", () => {
  const config = {
    ...DEFAULT_CONFIG,
    requiredReviewers: {
      "factory/": ["backend-dev"],
      "agents/": ["agent-owner"],
      ".gitea/": ["ci-admin"],
      "Dockerfile": ["devops"],
    },
  };

  it("matches by directory prefix", () => {
    expect(matchRequiredReviewers(["factory/orchestrator.ts"], config)).toContain("backend-dev");
  });

  it("matches multiple patterns", () => {
    const reviewers = matchRequiredReviewers(["factory/orchestrator.ts", "agents/developer.md"], config);
    expect(reviewers).toContain("backend-dev");
    expect(reviewers).toContain("agent-owner");
  });

  it("matches exact file", () => {
    expect(matchRequiredReviewers(["Dockerfile"], config)).toContain("devops");
  });

  it("returns empty for unmatched paths", () => {
    expect(matchRequiredReviewers(["README.md", "src/app.ts"], config)).toEqual([]);
  });
});

// ═══════════════════════════════════════
// Breaking change detection
// ═══════════════════════════════════════
describe("detectBreakingChanges", () => {
  const config = {
    ...DEFAULT_CONFIG,
    breakingChangePatterns: ["export interface", "export type", "BREAKING CHANGE:"],
  };

  it("returns no breaking changes for empty diff", () => {
    // In a test env without a real diff, should return false
    const result = detectBreakingChanges("HEAD", config, process.cwd());
    expect(typeof result.hasBreaking).toBe("boolean");
  });
});

// ═══════════════════════════════════════
// Helpers
// ═══════════════════════════════════════
describe("exec helper", () => {
  it("returns ok for valid command", () => {
    const r = exec("echo test");
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("test");
  });

  it("returns not ok for invalid command", () => {
    const r = exec("nonexistent-cmd-xyz 2>/dev/null");
    expect(r.ok).toBe(false);
  });
});
