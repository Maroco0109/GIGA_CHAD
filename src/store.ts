import type { Store } from "./types.js";

// ============================================================================
// Stream A 구현 대상.
// Phase 0에서는 인터페이스를 만족하는 스텁만 제공한다 (서버 부팅 가능하게).
// 메서드 호출 시 의도적으로 throw하여 "미구현"을 명확히 드러낸다.
// ============================================================================

export function createStore(_path: string): Store {
  const notImpl = (): never => {
    throw new Error("store not implemented yet — Stream A (src/store.ts)");
  };
  return {
    load: notImpl,
    save: notImpl,
    listCategories: notImpl,
    addCategory: notImpl,
    getCategoryByName: notImpl,
    addMemo: notImpl,
    queryMemos: notImpl,
  };
}
