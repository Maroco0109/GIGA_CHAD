# 내면의 기가채드 MCP — MVP 실행 계획

> 원본 비전: [`draft.md`](./draft.md)
> 이 문서는 **"일단 내 생각대로 돌아간다"** 를 최우선으로 하는 MVP 실행 계획이며,
> `ulw`(ultrawork) / `ralplan` 으로 **병렬 구현을 극대화**할 수 있도록 모듈 경계(seam)를 미리 못박아 설계했다.

---

## 0. 한 줄 요약

카카오톡 **"나와 대화하기"** 를 용도별 메모 저장소로 바꾸고, 그 메모를 context 삼아
질의응답·일정정리·URL분석을 해주며, **"내면의 기가채드"** 페르소나("삣삐"라고 부름)로 대화하는
**PlayMCP 직등록형 원격 MCP 서버(Streamable HTTP)**.

---

## 1. 확정된 의사결정 (Decision Log)

| 항목 | 결정 | 근거 |
|---|---|---|
| 배포 형태 | **PlayMCP 직등록형 원격 MCP** | 사용자 요구 ("playmcp.kakao.com에 바로 등록") |
| Transport | **Streamable HTTP** (`POST/GET /mcp`) + `GET /health` | PlayMCP는 최신 MCP SDK의 Streamable HTTP 사용, 게이트웨이가 원격 서버에 연결 |
| 스택 | **TypeScript + `@modelcontextprotocol/sdk` + Express** | PlayMCP 직등록 최적, 타입으로 모듈 계약(seam) 명확 → 병렬 구현 유리 |
| 데이터 소스 | **MCP 자체 저장** (사용자가 도구 호출로 메모 저장) | **"나와의 채팅" 극대화** — 사용자가 직접 저장하는 데이터에 집중, MVP 현실성 |
| 영속성 | **단일 JSON 파일** (`data/db.json`) | 의존성 0, MVP 데모 충분 |
| 세션 모드 | **Stateless** (`sessionIdGenerator: undefined`) | MVP 단순화, 세션 관리 복잡도 제거 |
| 추론 주체 | **호스트 LLM(카카오 AI)** 이 요약·판단, MCP는 **구조화된 context 반환** | MCP 모범 설계, 서버 단순화. (URL fetch 등 행위형만 서버가 수행) |
| 봇 아이덴티티 | 봇명 **`CHAD`** + **PlayMCP 기본 프로필 이미지** | 외부 기가채드 이미지는 저작권·초상권 리스크로 미사용 |

---

## 2. MVP 범위 (Scope Gate)

### 2.1 In Scope (이번에 반드시 돌아가야 하는 것)
- [x] 메모를 **용도(category)별** 저장 / 조회
- [x] 기본 카테고리 5종: **일정 / 연락처 / 파일 / 장소 / URL**
- [x] 사용자 **커스텀 카테고리 추가**
- [x] **카테고리/키워드 기반 메모 조회** → 호스트 LLM에 context 제공
- [x] **일정 정리**: KST(UTC+9) 기준 진행중/오늘/내일/1주일 일정 필터링하여 구조화 반환
- [x] **URL 분석**: 서버가 URL fetch → 제목·본문 발췌 + 1차 분류 제안(장소/정보/상품)
- [x] **기가채드 페르소나**: 서버 instructions + MCP prompt + "삣삐" 호칭 스타일
- [x] PlayMCP 등록 + `/health` 정상 + 도구 호출 end-to-end 데모

### 2.2 Out of Scope (MVP 이후, 지금 하지 않는다)
- 외부 일반 채팅방 → "나와의 채팅" 메시지 전송/연동 (이번 컨셉의 방향이 아님)
- 벡터 임베딩 기반 시맨틱 검색 (MVP는 키워드/카테고리 필터로 충분)
- 멀티유저 인증/격리, OAuth 사용자별 데이터 분리 (단일 사용자 전제)
- SQLite/외부 DB 마이그레이션 (JSON으로 시작)
- 자연어 날짜 파싱 고도화 (MVP는 ISO/단순 패턴 + 호스트 LLM 보정)
- 자동 카테고리 분류 ML (MVP는 키워드 룰 + 호스트 LLM override)

---

## 3. 아키텍처

```
[카카오 사용자] → [카카오 AI 호스트/LLM] → [PlayMCP 게이트웨이]
                                                  │ Streamable HTTP
                                                  ▼
                                    ┌──────────────────────────┐
                                    │  내면의 기가채드 MCP 서버   │
                                    │  Express + MCP SDK         │
                                    │  POST/GET /mcp  ·  /health  │
                                    └──────────────────────────┘
                                                  │
                                          data/db.json (JSON 영속)
```

**설계 원칙**
1. **호스트 LLM이 똑똑한 부분 담당** — MCP 도구는 구조화 데이터만 반환, 요약/말투/판단은 호스트가.
2. **행위형만 서버가 수행** — URL fetch처럼 LLM이 못하는 외부 I/O만 서버 처리.
3. **도구 = 파일 1개** — 각 도구 모듈이 독립 파일 + 독립 `registerXxx()` 함수. 공유 파일 동시 편집 금지 → 병렬 충돌 0.

### 3.1 파일 구조 (충돌 없는 병렬 설계)

```
giga-chad-mcp/
├── package.json            # Phase 0
├── tsconfig.json           # Phase 0
├── src/
│   ├── index.ts            # Phase 0 생성(전 모듈 register 호출 고정) → Phase 2 확정
│   ├── server.ts           # Phase 0: Express + Streamable HTTP + /health
│   ├── types.ts            # Phase 0: 전체 계약(seam) — Category, Memo, ToolCtx
│   ├── store.ts            # Stream A: JSON CRUD
│   ├── tools/
│   │   ├── memo.ts         # Stream B: save/query/list/add_category
│   │   ├── schedule.ts     # Stream C: get_schedule (KST)
│   │   └── url.ts          # Stream D: analyze_url
│   └── persona/
│       ├── persona.ts      # Stream E: instructions + prompt 등록
│       └── gigachad-style.md  # Stream E: 말투 가이드(임포트되는 문자열)
├── data/
│   └── db.json             # 런타임 생성 (시드 포함)
└── README.md               # Phase 3: 등록/실행 가이드
```

> **핵심**: `index.ts` 는 Phase 0에서 5개 `registerXxx(server, ctx)` 를 **이미 import/호출**하도록 만들어 둔다.
> 각 스트림은 **자기 파일만** 채우므로 Phase 1 동안 누구도 `index.ts` 를 건드리지 않는다 → 머지 충돌 제거.

---

## 4. 데이터 모델 (`types.ts` — 전체 계약)

```ts
// 모든 스트림이 이 계약에만 의존한다. Phase 0에서 확정 후 변경 금지.

export type BuiltinCategoryId = "schedule" | "contact" | "file" | "place" | "url";

export interface Category {
  id: string;            // slug (예: "schedule", "monitor-shopping")
  name: string;          // 표시명 (예: "일정")
  description: string;   // 용도 설명 (호스트 LLM이 분류 판단에 사용)
  builtin: boolean;
  createdAt: string;     // ISO8601
}

export interface Memo {
  id: string;            // uuid
  categoryId: string;    // Category.id 참조
  content: string;       // 원문 (사용자가 저장한 그대로)
  createdAt: string;     // ISO8601 (UTC 저장, 표시는 KST 변환)
  meta?: Record<string, unknown>; // 카테고리별 선택 구조화 필드 (예: schedule.startAt, url.url)
}

export interface DB {
  categories: Category[];
  memos: Memo[];
}

// 도구가 store에 접근하기 위한 컨텍스트 (DI seam)
export interface ToolCtx {
  store: Store;
}

export interface Store {
  load(): DB;
  save(db: DB): void;
  listCategories(): Category[];
  addCategory(name: string, description: string): Category;
  getCategoryByName(name: string): Category | undefined;
  addMemo(input: { categoryId: string; content: string; meta?: Record<string, unknown> }): Memo;
  queryMemos(filter: { categoryId?: string; keyword?: string }): Memo[];
}
```

### 4.1 기본 시드 (db.json 최초 생성 시)
```
일정(schedule) / 연락처(contact) / 파일(file) / 장소(place) / URL(url)
```

---

## 5. MCP 도구 명세 (Contract Surface)

> 모든 도구는 **stateless**, 입력은 zod 스키마, 출력은 `content: [{type:"text", text: JSON 또는 안내문}]`.
> 요약/말투는 호스트 LLM이 하므로, 도구는 **구조화된 사실**을 반환한다.

| 도구 | 입력 | 동작 | 반환 | 스트림 |
|---|---|---|---|---|
| `save_memo` | `content: string`, `category?: string` | category 미지정 시 키워드 룰로 후보 제안(저장은 호스트 확인 or "uncategorized"). 지정 시 해당 카테고리 저장 | 저장된 Memo + (분류 미지정 시) 후보 카테고리 | B |
| `list_categories` | — | 전체 카테고리 | Category[] | B |
| `add_category` | `name: string`, `description: string` | 커스텀 카테고리 추가 | 생성된 Category | B |
| `query_memos` | `category?: string`, `keyword?: string` | 카테고리/키워드 필터 | Memo[] (호스트 LLM context용) | B |
| `get_schedule` | `range: "today"\|"tomorrow"\|"week"` | KST 기준 일정 카테고리 메모 필터·정렬 | 진행중/예정 일정 구조화 리스트 | C |
| `analyze_url` | `url: string` | 서버가 URL fetch → title/본문 발췌 + 1차 분류 제안 | `{title, excerpt, suggestedClass: "장소"\|"정보"\|"상품"}` | D |

### 5.1 도구 등록 패턴 (모든 스트림 공통)
```ts
// src/tools/<name>.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ToolCtx } from "../types.js";

export function registerMemoTools(server: McpServer, ctx: ToolCtx) {
  server.registerTool("save_memo", { /* zod schema */ }, async (args) => { /* ... */ });
  // ...
}
```
> `index.ts` 는 `registerMemoTools / registerScheduleTools / registerUrlTools / registerPersona` 를 호출.

---

## 6. 페르소나 사양 — "내면의 기가채드" (Stream E)

**전달 방식 (MVP):**
1. MCP 서버 `instructions` 필드에 페르소나 시스템 가이드 주입
2. MCP `prompt` 등록: `inner_gigachad` (호스트가 페르소나 대화 시작 시 사용)
3. `gigachad-style.md` 문자열을 두 곳에 공급

**스타일 가이드 핵심 (gigachad-style.md):**
- 사용자 호칭은 항상 **"삣삐"**.
- 극도의 자기확신 + 따뜻한 응원. 주눅든 사용자를 강하게 북돋움.
- 시그니처: **"오브콜스, 삣삐."** / 짧고 단정적인 긍정.
- 예: Q.`"기가채드 거기 있어?"` → A.`"오브콜스, 삣삐."`
- 영어 슬랭 소량 가미(yes/absolutely/chad), 과하지 않게.
- 거칠지만 다정 — 절대 비꼬거나 깎아내리지 않음. 항상 사용자 편.
- 정보 전달(일정/URL 등) 시에도 말미에 짧은 응원 한 스푼.

---

## 7. 작업 분해 — 병렬 실행용 WBS (ulw / ralplan)

### Phase 0 — 기반 (순차, 단일 task, ~30분) 🔒 게이트
> **이게 끝나야 Phase 1 병렬이 시작된다.** 계약을 못박는 단계.
- `package.json` (`@modelcontextprotocol/sdk`, `express`, `zod`, `tsx`, `typescript`), `tsconfig.json`
- `src/types.ts` — §4 계약 전체 (이후 변경 금지)
- `src/server.ts` — Express + `StreamableHTTPServerTransport`(stateless) + `POST/GET /mcp` + `GET /health`(200 OK), 포트 3000
- `src/store.ts` **스텁** — Store 인터페이스 시그니처만 (Stream A가 구현)
- `src/index.ts` — 5개 `registerXxx()` import/호출을 **미리 다 작성** (구현은 빈 함수여도 컴파일되게)
- ✅ 검증: `npm run dev` → `curl localhost:3000/health` 200

### Phase 1 — 병렬 구현 (5 스트림 동시, 서로 의존 없음) ⚡
> 모두 §4 `types.ts` 계약에만 의존. 각자 **자기 파일만** 수정.

| 스트림 | 파일 | 산출물 | 독립 검증 |
|---|---|---|---|
| **A. Storage** | `src/store.ts` | JSON load/save + 시드 + 카테고리/메모 CRUD + 키워드 필터 | 단위 호출로 db.json 생성·조회 |
| **B. Memo Tools** | `src/tools/memo.ts` | `save_memo`/`list_categories`/`add_category`/`query_memos` + 키워드 분류 룰 | 인터페이스(Store) mock으로 도구 반환 검증 |
| **C. Schedule** | `src/tools/schedule.ts` | `get_schedule` — KST now 기준 today/tomorrow/week 필터·정렬 | 고정 시간 주입해 경계값 테스트 |
| **D. URL** | `src/tools/url.ts` | `analyze_url` — fetch + 제목/본문 발췌 + 장소/정보/상품 분류 휴리스틱 | 실제 URL 1~2개로 발췌 확인 |
| **E. Persona** | `src/persona/persona.ts`, `gigachad-style.md` | instructions 주입 + `inner_gigachad` prompt | prompt 등록/반환 문자열 확인 |

> **병렬 안전 규칙**: Phase 1 동안 `index.ts`/`types.ts`/`server.ts` **수정 금지**. 충돌 0 보장.

### Phase 2 — 통합 (순차, 게이트) 🔒
- Stream A의 실제 Store를 `index.ts` 에서 주입(`ctx = { store }`)
- 전체 도구 등록 확인, 타입 에러 0 (`tsc --noEmit`)
- **스모크 테스트**: `@modelcontextprotocol/inspector` 또는 curl 스크립트로 `/mcp` 에 각 도구 1회씩 호출
- ✅ 검증 체크리스트: 도구 6종 호출 성공 + db.json 반영 + persona prompt 노출

### Phase 3 — 배포 & 등록 (순차)
- 공개 URL 확보: **데모는 ngrok**(즉시 HTTPS), **제출은 Railway/Render/Fly**(안정 URL)
- **봇 아이덴티티**: 봇명을 **`CHAD`** 로 등록, 프로필 이미지는 **PlayMCP 기본 이미지** 사용 (외부 기가채드 이미지는 저작권·초상권 이슈로 미사용)
- PlayMCP에 서버 URL(`https://<host>/mcp`) 등록, `/health` 확인
- 카카오 AI에서 도구 호출 end-to-end 데모 시나리오 1회 통과 (**상세 절차·필요성은 §10 참조**)
- `README.md` — 실행/등록/데모 가이드

---

## 8. 실행 순서 요약 (의존성 그래프)

```
Phase 0 (계약 확정) ─┬─ A. Storage  ──┐
                     ├─ B. Memo      ──┤
                     ├─ C. Schedule  ──┼─→ Phase 2 (통합·스모크) ─→ Phase 3 (배포·등록)
                     ├─ D. URL       ──┤
                     └─ E. Persona   ──┘
   순차 게이트          ⚡ 5-way 병렬          순차 게이트            순차
```

- **ulw 투입 지점**: Phase 1 (5 스트림을 5 executor에 병렬 분배).
- **ralplan 활용**: Phase 0 직전, 본 WBS를 합의·확정하는 게이트로 사용.

---

## 9. 데모 시나리오 (수용 기준 = "내 생각대로 돈다")

1. `save_memo("내일 14시 치과 예약", "일정")` → 저장됨
2. `save_memo("https://map.naver.com/...", "URL")` → 저장됨
3. **"오늘/내일 일정 정리해줘"** → `get_schedule("tomorrow")` → "내일 14시 치과" 정리 + 기가채드 응원
4. **"이 URL 뭐야"** → `analyze_url(...)` → 제목/요약 + "장소" 분류 제안
5. **"나 모니터 뭐 살지 모르겠어"** → `query_memos(category:"URL"/"상품")` → 저장된 상품 링크 context로 답변
6. **"기가채드 거기 있어?"** → `"오브콜스, 삣삐."`

---

## 10. PlayMCP 환경 구동·테스트 (필요성 + 방법)

> **핵심 명제**: 로컬에서 도는 것은 **필요조건**일 뿐이다. 이 작품의 무대는 카카오 PlayMCP이며,
> **"내 생각대로 돈다"의 진짜 수용 기준은 카카오 채팅창에서의 end-to-end 통과**다.

### 10.1 왜 PlayMCP에서 반드시 테스트해야 하는가 (필요성)
로컬 `/health` 200 + Inspector 도구 호출 성공으로는 **드러나지 않는 차이**가 있다. 아래는 PlayMCP에서만 검증 가능:

| 항목 | 로컬에선 안 보이는 이유 |
|---|---|
| **게이트웨이 경유** | 실제 호출은 카카오 게이트웨이(`https://playmcp.kakao.com/mcp`)를 거침 → 인증·헤더·세션 처리, **공개 URL 도달성**, 네트워크 지연이 로컬과 다름 |
| **OAuth(PKCE) 인증** | 카카오 계정 OAuth + PKCE 단계가 추가됨. 로컬엔 없던 인증 흐름 |
| **호스트 LLM의 도구 선택** | 카카오 AI가 **도구 description만 보고** 호출 여부·인자를 판단 → 이름/설명이 부실하면 로컬에선 되던 게 실제론 호출이 안 됨 |
| **페르소나 실측** | 서버 `instructions`/`prompt`를 카카오 호스트가 실제 반영하는지는 **PlayMCP에서만 확인 가능** (§11 리스크와 직결) |
| **공개 도달성·안정성** | ngrok/배포 URL이 외부에서 실제로 닿는지, 세션 만료·콜드스타트 발생 여부 |

### 10.2 등록 절차 (개발자)
1. `playmcp.kakao.com` **카카오 계정 로그인**
2. **공개 HTTPS URL 확보** (`https://<host>/mcp` + `/health` 동작 필수) — 데모는 ngrok, 제출은 Railway/Render
3. MCP 서버 등록: **서버 URL + 봇명 `CHAD` + 기본 프로필 이미지(디폴트)** + 설명
4. **임시(비공개) 등록 상태**로 시작 → 본인만 테스트
5. 검증 후 **공개 전환** (다른 사용자도 도구함에 추가 가능)
6. (범위 밖) 외부 AI 서비스 배포는 **카카오 파트너 검증** 필요 — MVP/제출엔 불필요

### 10.3 구동·테스트 방법 (2단계)
**A. 로컬 사전 점검** (= Phase 2)
- `npm run dev` → `curl localhost:3000/health` 200 → MCP Inspector로 도구 6종 호출 확인

**B. PlayMCP 실환경 테스트** (필수, = Phase 3 수용 기준)
- 등록 직후 PlayMCP **AI 채팅 대화창에서 직접 테스트**
- 도구함에 본 MCP 추가 → 채팅으로 **§9 데모 시나리오 1~6을 그대로 실행**
- 확인 포인트: ① 도구가 자동 호출되는가 ② 인자가 정확한가 ③ 일정/URL 결과가 정상인가 ④ 페르소나("삣삐"/"오브콜스")가 응답에 반영되는가

### 10.4 로컬 ↔ PlayMCP 패리티 체크리스트
| 검증 항목 | 로컬 | PlayMCP 실환경 |
|---|---|---|
| `/health` 200 | ✅ curl | ✅ 등록 시 자동 점검 |
| 도구 6종 호출 | Inspector/curl | **카카오 채팅 자동 호출** |
| 인증 | 없음 | **OAuth + PKCE 통과** |
| 페르소나 반영 | 문자열 등록 확인 | **실제 응답 말투 확인** |
| 데모 시나리오 1~6 | curl 스크립트 | **채팅 end-to-end 통과** |

> 이 표의 **PlayMCP 열이 전부 통과**해야 MVP 완료로 간주한다.

---

## 11. 리스크 & 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| PlayMCP 게이트웨이 OAuth/등록 제약 | 등록 실패 | Phase 3 초반에 **빈 서버로 등록 PoC 먼저** 통과시키고 도구 채우기 |
| 호스트 LLM이 서버 `instructions`/`prompt` 미사용 | 페르소나 약화 | 페르소나를 **도구 반환 텍스트에도** 일부 녹여 이중화 |
| 공개 URL 불안정(ngrok 세션 만료) | 데모 끊김 | 제출용은 Railway/Render 고정 URL 사용 |
| Streamable HTTP stateless 호환성 | 일부 클라이언트 이슈 | SDK 공식 stateless 예제 패턴 준수, 안되면 stateful로 폴백 |
| 날짜 파싱 부정확 | 일정 오정렬 | MVP는 ISO/단순패턴만, 모호하면 원문 그대로 반환해 호스트 LLM이 보정 |

---

## 12. 다음 액션

> **주의**: `ralplan`은 **계획 합의 모듈**(Planner↔Architect↔Critic 루프)이라 **코드를 구현하지 않는다.**
> `pending approval` 계획만 산출하고 멈춘다. 이미 `plan.md`가 상세하므로 **착수(구현)는 실행 모드로 바로 가는 것을 권장**한다.

**권장 경로 (MVP 우선, 구현 직행):**
1. **Phase 0** — 기반/계약 직접 구현 (단일 task, 충돌 없음)
2. **`/oh-my-claudecode:ultrawork`** — Phase 0 직후 Phase 1 다섯 스트림 병렬 구현
3. **Phase 2~3** — 통합·스모크 → PlayMCP 등록·실환경 테스트(§10)

**선택: 착수 전 `plan.md`를 한 번 더 검증받고 싶을 때만**
- **`/oh-my-claudecode:ralplan`** — 기존 계획에 Architect·Critic 합의/하드닝 패스. **구현은 안 하고** 검증된 계획만 산출 → 이후 실행 모드로 핸드오프
