// ============================================================================
// 전체 계약(seam) — 모든 스트림이 이 파일에만 의존한다.
// Phase 0에서 확정. Phase 1 동안 수정 금지.
// ============================================================================

export type BuiltinCategoryId = "schedule" | "contact" | "file" | "place" | "url";

export interface Category {
  id: string; // slug (예: "schedule", "monitor-shopping")
  name: string; // 표시명 (예: "일정")
  description: string; // 용도 설명 (호스트 LLM이 분류 판단에 사용)
  builtin: boolean;
  createdAt: string; // ISO8601
}

export interface Memo {
  id: string; // uuid
  categoryId: string; // Category.id 참조
  content: string; // 원문 (사용자가 저장한 그대로)
  createdAt: string; // ISO8601 (UTC 저장, 표시는 KST 변환)
  meta?: Record<string, unknown>; // 카테고리별 선택 구조화 필드
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
