import * as fs from "node:fs";
import * as path from "node:path";

export interface ReviewConfig {
  minDiverseReviews: number;
  requiredReviewers: Record<string, string[]>;
  staleDays: number;
  protectedPaths: string[];
  breakingChangePatterns: string[];
}

export const DEFAULT_CONFIG: ReviewConfig = {
  minDiverseReviews: 1,
  requiredReviewers: {},
  staleDays: 14,
  protectedPaths: [".gitea/workflows/", "docker-compose.yml", "Dockerfile", ".env.example", "agents/", "factory/package.json"],
  breakingChangePatterns: ["export interface", "export type", "export function", "export class", "BREAKING CHANGE:"],
};

export function loadConfig(cwd: string): ReviewConfig {
  const configPath = path.join(cwd, ".reviewrc.yml");
  if (!fs.existsSync(configPath)) return { ...DEFAULT_CONFIG };
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const result: Record<string, unknown> = {};
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*([\w][\w.*\/-]+):\s*(.+)$/);
      if (m) {
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        result[m[1]] = val;
      }
    }
    const reviewers: Record<string, string[]> = {};
    for (const [key, val] of Object.entries(result)) {
      if (key.startsWith("requiredReviewers.")) {
        reviewers[key.replace("requiredReviewers.", "")] = (val as string).split(",").map(s => s.trim()).filter(Boolean);
      }
    }
    const minDiverseReviews = parseInt(result["minDiverseReviews"] as string);
    const staleDays = parseInt(result["staleDays"] as string);
    return {
      minDiverseReviews: isNaN(minDiverseReviews) ? DEFAULT_CONFIG.minDiverseReviews : minDiverseReviews,
      requiredReviewers: reviewers,
      staleDays: isNaN(staleDays) ? DEFAULT_CONFIG.staleDays : staleDays,
      protectedPaths: (result["protectedPaths"] as string)?.split(",").map(s => s.trim()).filter(Boolean) || DEFAULT_CONFIG.protectedPaths,
      breakingChangePatterns: (result["breakingChangePatterns"] as string)?.split(",").map(s => s.trim()).filter(Boolean) || DEFAULT_CONFIG.breakingChangePatterns,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
