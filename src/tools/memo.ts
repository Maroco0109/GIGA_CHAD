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
        "메모를 저장합니다. 카테고리를 지정하면 해당 카테고리에 저장하고, " +
        "생략하면 내용을 분석해 자동으로 분류합니다.",
      inputSchema: {
        content: z.string().describe("저장할 메모 내용"),
        category: z
          .string()
          .optional()
          .describe("카테고리 이름 (생략 시 자동 분류)"),
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

        const memo = ctx.store.addMemo({ categoryId, content: args.content });

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
}
