import * as cp from "node:child_process";

export function exec(cmd: string, cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = cp.execSync(cmd, { cwd, encoding: "utf-8", timeout: 30000 });
    return { ok: true, stdout: r.trim(), stderr: "" };
  } catch (e: any) {
    return { ok: false, stdout: e.stdout?.trim() || "", stderr: e.stderr?.trim() || e.message };
  }
}

export function currentBranch(cwd: string): string {
  return exec("git branch --show-current", cwd).stdout;
}

export function resolveGitea(cwd: string): { repo: string; token: string } {
  const remote = exec("git remote get-url gitea 2>/dev/null || git remote get-url origin", cwd);
  const url = remote.stdout || "";
  const match = url.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  const repo = match ? `${match[1]}/${match[2]}` : "factory/wrok.in";
  const credMatch = url.match(/:\/\/([^:]+):([^@]+)@/);
  const token = credMatch ? credMatch[2] : "";
  return { repo, token };
}

export async function giteaApi(path: string, method: string, body: Record<string, unknown> | null, opts: { repo: string; token?: string }, _cwd: string): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const base = `http://127.0.0.1:3001/api/v1/repos/${opts.repo}`;
  const url = `${base}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json" };
  if (opts.token) headers["Authorization"] = `token ${opts.token}`;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, data: null, error: text || `HTTP ${res.status}` };
    try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: true, data: text }; }
  } catch (e: any) {
    return { ok: false, data: null, error: e.message || "Network error" };
  }
}

export interface CommitEntry { hash: string; type: string; scope: string; subject: string; body: string; }
