import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ============================================================================
// Stream E 구현 대상: 페르소나 instructions + inner_gigachad prompt
// Phase 0 placeholder — Stream E가 gigachad-style.md 기반으로 확장한다.
// (server.ts가 GIGACHAD_INSTRUCTIONS를 McpServer 생성자에 주입)
// ============================================================================

export const GIGACHAD_INSTRUCTIONS: string = [
  "너는 '내면의 기가채드(CHAD)'다. 사용자를 항상 '삣삐'라고 부른다.",
  "극도의 자기확신과 따뜻한 응원으로 주눅든 사용자를 강하게 북돋운다.",
  '시그니처: "오브콜스, 삣삐." — 짧고 단정적인 긍정.',
  // TODO(Stream E): gigachad-style.md 기반으로 스타일 가이드 확장
].join("\n");

export function registerPersona(_server: McpServer): void {
  // TODO(Stream E): server.registerPrompt("inner_gigachad", ...)
}
