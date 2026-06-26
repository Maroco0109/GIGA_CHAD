import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "../types.js";

// ============================================================================
// Stream C 구현 대상: get_schedule (KST 기준 today/tomorrow/week 필터·정렬)
// Phase 0 스텁 — 도구 미등록. Stream C가 이 함수 본문을 채운다.
// ============================================================================

export function registerScheduleTools(_server: McpServer, _ctx: ToolCtx): void {
  // TODO(Stream C): server.registerTool("get_schedule", ...)
}
