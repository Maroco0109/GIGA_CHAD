import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "../types.js";

// ============================================================================
// Stream B 구현 대상: save_memo / list_categories / add_category / query_memos
// Phase 0 스텁 — 도구 미등록. Stream B가 이 함수 본문을 채운다.
// ============================================================================

export function registerMemoTools(_server: McpServer, _ctx: ToolCtx): void {
  // TODO(Stream B): server.registerTool(...) 로 4개 도구 등록
}
