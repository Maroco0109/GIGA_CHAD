import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "../types.js";

// ============================================================================
// Stream D 구현 대상: analyze_url (fetch → 제목/본문 발췌 + 장소/정보/상품 분류)
// Phase 0 스텁 — 도구 미등록. Stream D가 이 함수 본문을 채운다.
// ============================================================================

export function registerUrlTools(_server: McpServer, _ctx: ToolCtx): void {
  // TODO(Stream D): server.registerTool("analyze_url", ...)
}
