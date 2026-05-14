/**
 * pi-review-gate — CI-Level Merge Guardian
 *
 * Tools: review_check, review_approve, review_request, review_status, review_close_stale
 * Config: .reviewrc.yml
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { interceptToolCall } from "./intercepts";
import { checkTool } from "./tools/check";
import { approveTool, requestTool, statusTool, closeStaleTool } from "./tools/review";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", interceptToolCall);
  pi.registerTool(checkTool);
  pi.registerTool(approveTool);
  pi.registerTool(requestTool);
  pi.registerTool(statusTool);
  pi.registerTool(closeStaleTool);
}
