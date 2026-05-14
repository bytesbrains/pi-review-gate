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

export function giteaApi(path: string, method: string, body: Record<string, unknown> | null, opts: { repo: string; token?: string }, cwd: string): { ok: boolean; data: unknown; error?: string } {
  const base = `http://127.0.0.1:3001/api/v1/repos/${opts.repo}`;
  const headers = [opts.token ? `-H "Authorization: token ${opts.token}"` : "", `-H "Content-Type: application/json"`, `-H "Accept: application/json"`].filter(Boolean).join(" ");
  const dataFlag = body ? `-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'` : "";
  const r = exec(`curl -sf -w "\\n%{http_code}" -X ${method} "${base}${path}" ${headers} ${dataFlag}`, cwd);
  if (!r.ok) {
    const lines = r.stdout.split("\n");
    const bodyText = lines.slice(0, -1).join("\n");
    return { ok: false, data: null, error: r.stderr || bodyText || "API error" };
  }
  const lines = r.stdout.split("\n");
  const bodyText = lines.slice(0, -1).join("\n");
  try { return { ok: true, data: JSON.parse(bodyText) }; } catch { return { ok: true, data: bodyText }; }
}

export interface CommitEntry { hash: string; type: string; scope: string; subject: string; body: string; }
