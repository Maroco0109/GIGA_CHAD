// ============================================================================
// CHAD MCP — 로컬 호스트 하니스
// OpenAI(=카카오 호스트 LLM 대역) ↔ 우리 MCP 서버 의 전체 송수신 루프를
// localhost에서 그대로 재현한다.
//
// 사용법:
//   1) 다른 터미널에서 서버 기동:  npm run dev   (기본 :3000)
//   2) 키 넣고 실행:               OPENAI_API_KEY=sk-... node scripts/host-test.mjs
//      - 인자로 한 줄 질문:        OPENAI_API_KEY=sk-... node scripts/host-test.mjs "내일 일정 정리해줘"
//      - 인자 없으면 대화형 REPL (exit 입력 시 종료)
//   환경변수: PORT(기본 3000), OPENAI_MODEL(기본 gpt-4o-mini)
//
// 키가 없으면 MCP 연결/도구 목록만 출력하고 종료한다(배선 점검용).
// ============================================================================
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = process.env.PORT ?? "3000";
const MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

// ── 1. MCP 서버 연결 ────────────────────────────────────────────────────────
const mcp = new Client({ name: "chad-host-test", version: "0.0.0" });
try {
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));
} catch (e) {
  console.error(`✗ MCP 서버(:${PORT})에 연결 실패. 먼저 'npm run dev'로 서버를 띄웠는지 확인해.\n  ${e.message}`);
  process.exit(1);
}

const instructions = (typeof mcp.getInstructions === "function" ? mcp.getInstructions() : "") ?? "";
const { tools } = await mcp.listTools();
console.log(`✓ MCP 연결됨 (:${PORT}) — 도구 ${tools.length}개: ${tools.map((t) => t.name).join(", ")}`);
console.log(`✓ 서버 instructions(페르소나) ${instructions.length}자 수신${instructions ? "" : " — 비어있음!"}`);

// ── 2. 키 없으면 배선 점검만 하고 종료 ──────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.log("\nℹ️  OPENAI_API_KEY 가 없어 LLM 호출은 건너뜀 (MCP 배선 점검 완료).");
  console.log("   실제 대화 테스트: OPENAI_API_KEY=sk-... node scripts/host-test.mjs \"내일 일정 정리해줘\"");
  await mcp.close();
  process.exit(0);
}

// ── 3. MCP 도구 → OpenAI function tool 변환 ─────────────────────────────────
const oaTools = tools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description ?? "",
    parameters: t.inputSchema ?? { type: "object", properties: {} },
  },
}));

const { default: OpenAI } = await import("openai");
const openai = new OpenAI();

// 서버 instructions를 system 프롬프트로 주입 (PlayMCP 호스트와 동일 조건)
const messages = [{ role: "system", content: instructions || "너는 CHAD다." }];

// ── 4. 한 턴 처리: 모델 호출 → tool_calls 실행 → 결과 회신 → 최종 응답 ───────
async function runTurn(userText) {
  messages.push({ role: "user", content: userText });
  console.log(`\n👤 삣삐: ${userText}`);
  for (let hop = 0; hop < 6; hop++) {
    const res = await openai.chat.completions.create({ model: MODEL, messages, tools: oaTools });
    const msg = res.choices[0].message;
    messages.push(msg);
    if (msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
        console.log(`🛠️  ${tc.function.name}(${JSON.stringify(args)})`);
        let resultText;
        try {
          const r = await mcp.callTool({ name: tc.function.name, arguments: args });
          resultText = (r.content ?? []).map((c) => c.text ?? "").join("\n");
        } catch (e) {
          resultText = `ERROR: ${e.message}`;
        }
        console.log(`   ↳ ${resultText.slice(0, 400)}${resultText.length > 400 ? "…" : ""}`);
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
      }
      continue; // 결과를 받아 다시 모델에게
    }
    console.log(`\n🤖 CHAD: ${msg.content}`);
    return;
  }
  console.log("⚠️  tool 호출이 6홉을 넘겨 중단.");
}

// ── 5. 단발 or 대화형 ───────────────────────────────────────────────────────
const argText = process.argv.slice(2).join(" ").trim();
if (argText) {
  await runTurn(argText);
  await mcp.close();
  process.exit(0);
}

console.log(`\n💬 대화형 모드 (model=${MODEL}). 질문을 입력해 (exit 입력 시 종료).`);
const rl = readline.createInterface({ input, output });
while (true) {
  const line = (await rl.question("\n삣삐> ")).trim();
  if (!line) continue;
  if (line === "exit" || line === "quit") break;
  try { await runTurn(line); } catch (e) { console.error("turn error:", e.message); }
}
rl.close();
await mcp.close();
