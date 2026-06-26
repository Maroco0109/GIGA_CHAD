import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "../types.js";

// ============================================================================
// Stream B 구현 대상: save_memo / list_categories / add_category / query_memos
// ============================================================================

// ---------------------------------------------------------------------------
// 자동 분류 키워드 규칙 (카테고리 없이 저장할 때 사용)
//
// 우선순위 순서대로 평가한다:
//   1. url      — http/https 프로토콜 포함
//   2. contact  — 전화번호 패턴(010-XXXX-XXXX) 또는 "전화/연락처/폰/번호" 키워드
//   3. file     — 파일 확장자(.pdf/.png/.zip 등) 또는 "파일" 키워드
//   4. place    — "지도/네이버지도/카카오맵/구글맵/주소/장소/위치" 키워드
//   5. schedule — "예약/일정/내일/오늘/요일/날짜/시간" 키워드, 또는 시각 표현
//   6. schedule — 위 어디에도 해당하지 않으면 schedule로 폴백
// ---------------------------------------------------------------------------

type BuiltinCategoryId = "url" | "contact" | "file" | "place" | "schedule";

function guessCategory(content: string): BuiltinCategoryId {
  if (/https?:\/\//i.test(content)) return "url";

  if (/010[-\s]?\d{3,4}[-\s]?\d{4}|전화|연락처|폰|핸드폰|휴대폰|번호/.test(content))
    return "contact";

  if (/파일|\.pdf|\.png|\.zip|\.jpg|\.jpeg|\.gif|\.docx|\.xlsx|\.pptx|\.txt|\.csv/i.test(content))
    return "file";

  if (/지도|네이버지도|카카오맵|구글맵|주소|장소|위치/.test(content))
    return "place";

  if (/예약|일정|내일|오늘|모레|요일|날짜|월요일|화요일|수요일|목요일|금요일|토요일|일요일|시간|분에|까지|\d+시|\d+월|\d+일/.test(content))
    return "schedule";

  return "schedule";
}

export function registerMemoTools(server: McpServer, ctx: ToolCtx): void {
  // -----------------------------------------------------------------------
  // 1. save_memo
  // -----------------------------------------------------------------------
  server.registerTool(
    "save_memo",
    {
      title: "메모 저장",
      description:
        "메모를 저장합니다. 카테고리를 지정하면 해당 카테고리에 저장하고, 생략하면 자동 분류합니다. " +
        "링크를 기억해두려면 그 URL을 이 도구로 저장하세요. " +
        "일정(날짜·시간) 메모는 사용자의 원래 표현(내일/오늘/날짜/오전·오후 등)을 content에 그대로 보존하고, " +
        "가능하면 startAt에 절대 시각(ISO8601)을 함께 전달하세요.",
      inputSchema: {
        content: z.string().describe("저장할 메모 내용 (일정이면 '내일 오후 6시 저녁식사'처럼 시간 표현을 그대로 포함)"),
        category: z
          .string()
          .optional()
          .describe("카테고리 이름 (생략 시 자동 분류)"),
        startAt: z
          .string()
          .optional()
          .describe("일정의 절대 시각 ISO8601 (예: 2026-06-28T18:00:00+09:00). 상대 표현은 호스트가 KST 기준 절대 시각으로 변환해 전달"),
      },
    },
    async (args) => {
      try {
        let categoryId: string;
        let autoClassified = false;
        let suggestedCategory: string | undefined;

        if (args.category !== undefined && args.category !== "") {
          // 명시적 카테고리: 조회 → 없으면 생성
          const existing = ctx.store.getCategoryByName(args.category);
          if (existing) {
            categoryId = existing.id;
          } else {
            const created = ctx.store.addCategory(
              args.category,
              "사용자 정의 카테고리"
            );
            categoryId = created.id;
          }
        } else {
          // 카테고리 생략: 키워드 규칙으로 자동 분류
          categoryId = guessCategory(args.content);
          suggestedCategory = categoryId;
          autoClassified = true;
        }

        const meta = args.startAt ? { startAt: args.startAt } : undefined;
        const memo = ctx.store.addMemo({ categoryId, content: args.content, meta });

        const result = autoClassified
          ? { ...memo, suggestedCategory, autoClassified: true }
          : memo;

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error saving memo: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // 2. list_categories
  // -----------------------------------------------------------------------
  server.registerTool(
    "list_categories",
    {
      title: "카테고리 목록",
      description: "저장된 모든 카테고리를 반환합니다.",
      inputSchema: {},
    },
    async (_args) => {
      try {
        const categories = ctx.store.listCategories();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(categories) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error listing categories: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // 3. add_category
  // -----------------------------------------------------------------------
  server.registerTool(
    "add_category",
    {
      title: "카테고리 추가",
      description: "새 카테고리를 생성합니다.",
      inputSchema: {
        name: z.string().describe("카테고리 이름 (슬러그 또는 표시명)"),
        description: z.string().describe("카테고리 용도 설명"),
      },
    },
    async (args) => {
      try {
        const category = ctx.store.addCategory(args.name, args.description);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(category) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error adding category: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // 4. query_memos
  // -----------------------------------------------------------------------
  server.registerTool(
    "query_memos",
    {
      title: "메모 검색",
      description:
        "카테고리 이름 또는 키워드로 메모를 검색합니다. 둘 다 생략하면 전체를 반환합니다.",
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("필터링할 카테고리 이름 (생략 시 전체 카테고리)"),
        keyword: z
          .string()
          .optional()
          .describe("메모 내용에서 검색할 키워드"),
      },
    },
    async (args) => {
      try {
        let categoryId: string | undefined;

        if (args.category !== undefined && args.category !== "") {
          const cat = ctx.store.getCategoryByName(args.category);
          categoryId = cat?.id;
        }

        const memos = ctx.store.queryMemos({
          categoryId,
          keyword: args.keyword,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(memos) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error querying memos: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // 5. delete_memo
  // -----------------------------------------------------------------------
  server.registerTool(
    "delete_memo",
    {
      title: "메모/일정 삭제",
      description:
        "id로 메모(일정 포함)를 삭제합니다. 사용자가 일정·약속·메모를 '취소·삭제·지워'라고 하면, " +
        "먼저 query_memos로 대상 메모를 찾아 그 id를 확인한 뒤 이 도구를 호출하세요. " +
        "후보가 여럿이면 임의로 지우지 말고 어떤 것을 지울지 사용자에게 확인한 뒤 삭제하세요.",
      inputSchema: {
        id: z
          .string()
          .describe("삭제할 메모의 id (query_memos 결과 항목의 id 필드 값)"),
      },
    },
    async (args) => {
      try {
        const removed = ctx.store.deleteMemo(args.id);
        if (!removed) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ deleted: false, reason: "not_found", id: args.id }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ deleted: true, memo: removed }),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error deleting memo: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );

  // -----------------------------------------------------------------------
  // 6. delete_category
  // -----------------------------------------------------------------------
  server.registerTool(
    "delete_category",
    {
      title: "카테고리 삭제",
      description:
        "사용자 정의 카테고리를 삭제합니다. 기본 제공 카테고리(일정/연락처/파일/장소/URL)는 삭제할 수 없습니다. " +
        "해당 카테고리에 메모가 남아 있으면 삭제되지 않으니(reason=has_memos), 먼저 query_memos로 메모를 확인해 " +
        "delete_memo로 비우거나 다른 카테고리로 옮긴 뒤 다시 시도하세요.",
      inputSchema: {
        name: z.string().describe("삭제할 카테고리 이름 또는 id"),
      },
    },
    async (args) => {
      try {
        const result = ctx.store.deleteCategory(args.name);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error deleting category: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  );
}
