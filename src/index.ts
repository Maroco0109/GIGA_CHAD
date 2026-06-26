import { startHttpServer } from "./server.js";
import { createStore } from "./store.js";
import { registerMemoTools } from "./tools/memo.js";
import { registerScheduleTools } from "./tools/schedule.js";
import { registerUrlTools } from "./tools/url.js";
import { registerPersona, installPersonaReinforcement } from "./persona/persona.js";
import type { ToolCtx } from "./types.js";

// ── 의존성 조립 (Phase 0에서 전 모듈 register 호출을 고정) ──────────────────
// Phase 1 동안 이 파일은 수정하지 않는다. 각 스트림은 자기 모듈 파일만 채운다.

const store = createStore(process.env.DB_PATH ?? "./data/db.json");
const ctx: ToolCtx = { store };

startHttpServer({
  port: Number(process.env.PORT ?? 3000),
  register: (server) => {
    installPersonaReinforcement(server); // 이후 등록되는 모든 tool 응답에 페르소나 주입 (먼저 호출)
    registerPersona(server); // inner_gigachad 페르소나 tool 노출
    registerMemoTools(server, ctx); // Stream B
    registerScheduleTools(server, ctx); // Stream C
    registerUrlTools(server, ctx); // Stream D
  },
});
