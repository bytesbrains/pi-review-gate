import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export async function interceptToolCall(event: any, ctx: ExtensionContext) {
  if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
  const cmd = event.input.command;

  if (/\bgit\s+merge\b/.test(cmd)) {
    const ok = await ctx.ui.confirm("Manual merge blocked", `Direct git merge bypasses review gates.\n\nCommand: ${cmd}\n\nUse review tools instead.\n\nAllow anyway?`);
    if (!ok) return { block: true, reason: "Use review tools. CI performs the merge after all gates pass." };
  }
  if (/\bgh\s+pr\s+close\b/.test(cmd) || /\bgit\s+push\b.*--delete/.test(cmd)) {
    ctx.ui.notify("Consider using review_close_stale() for PR lifecycle management.", "warning");
  }
}
