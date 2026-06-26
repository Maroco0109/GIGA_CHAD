import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Category, DB, DeleteCategoryResult, Memo, Store } from "./types.js";

// ============================================================================
// Stream A: JSON-file-backed Store implementation
// ============================================================================

const BUILTIN_SEEDS: Omit<Category, "createdAt">[] = [
  {
    id: "schedule",
    name: "일정",
    description: "날짜·시간이 있는 약속, 할 일, 리마인더를 저장합니다.",
    builtin: true,
  },
  {
    id: "contact",
    name: "연락처",
    description: "사람·기관의 이름, 전화번호, 이메일 등 연락 정보를 저장합니다.",
    builtin: true,
  },
  {
    id: "file",
    name: "파일",
    description: "로컬·클라우드 파일의 경로나 공유 링크를 기록합니다.",
    builtin: true,
  },
  {
    id: "place",
    name: "장소",
    description: "주소, 좌표, 방문 메모 등 장소 정보를 저장합니다.",
    builtin: true,
  },
  {
    id: "url",
    name: "URL",
    description: "북마크, 참고 링크, 공유 URL 등 웹 주소를 저장합니다.",
    builtin: true,
  },
];

function seedDB(): DB {
  const now = new Date().toISOString();
  return {
    categories: BUILTIN_SEEDS.map((c) => ({ ...c, createdAt: now })),
    memos: [],
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function createStore(dbPath: string): Store {
  let cache: DB | null = null;

  function load(): DB {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(dbPath, "utf-8");
      const parsed = JSON.parse(raw) as DB;
      if (!Array.isArray(parsed.categories) || !Array.isArray(parsed.memos)) {
        throw new Error("invalid db shape");
      }
      cache = parsed;
      return cache;
    } catch {
      // File missing or corrupt — seed and persist
      cache = seedDB();
      save(cache);
      return cache;
    }
  }

  function save(db: DB): void {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), "utf-8");
    cache = db;
  }

  function listCategories(): Category[] {
    return load().categories;
  }

  function addCategory(name: string, description: string): Category {
    const db = load();

    // Idempotent: return existing if same name
    const existing = db.categories.find(
      (c) => c.name.toLowerCase() === name.toLowerCase()
    );
    if (existing) return existing;

    let id = slugify(name);
    if (!id) id = randomUUID().slice(0, 8);

    // Ensure unique id
    const usedIds = new Set(db.categories.map((c) => c.id));
    if (usedIds.has(id)) {
      id = `${id}-${randomUUID().slice(0, 6)}`;
    }

    const category: Category = {
      id,
      name,
      description,
      builtin: false,
      createdAt: new Date().toISOString(),
    };
    db.categories.push(category);
    save(db);
    return category;
  }

  function getCategoryByName(name: string): Category | undefined {
    const lower = name.toLowerCase();
    return load().categories.find(
      (c) => c.name.toLowerCase() === lower || c.id.toLowerCase() === lower
    );
  }

  function addMemo(input: {
    categoryId: string;
    content: string;
    meta?: Record<string, unknown>;
  }): Memo {
    const db = load();
    const memo: Memo = {
      id: randomUUID(),
      categoryId: input.categoryId,
      content: input.content,
      createdAt: new Date().toISOString(),
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
    };
    db.memos.push(memo);
    save(db);
    return memo;
  }

  function queryMemos(filter: {
    categoryId?: string;
    keyword?: string;
  }): Memo[] {
    let memos = load().memos;

    if (filter.categoryId !== undefined) {
      memos = memos.filter((m) => m.categoryId === filter.categoryId);
    }

    if (filter.keyword !== undefined) {
      const kw = filter.keyword.toLowerCase();
      memos = memos.filter((m) => m.content.toLowerCase().includes(kw));
    }

    // Newest-first
    return memos.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function deleteMemo(id: string): Memo | null {
    const db = load();
    const idx = db.memos.findIndex((m) => m.id === id);
    if (idx === -1) return null;
    const [removed] = db.memos.splice(idx, 1);
    save(db);
    return removed;
  }

  function deleteCategory(idOrName: string): DeleteCategoryResult {
    const db = load();
    const lower = idOrName.toLowerCase();
    const idx = db.categories.findIndex(
      (c) => c.id.toLowerCase() === lower || c.name.toLowerCase() === lower
    );
    if (idx === -1) return { ok: false, reason: "not_found" };

    const category = db.categories[idx];
    if (category.builtin) return { ok: false, reason: "builtin", category };

    const memoCount = db.memos.filter((m) => m.categoryId === category.id).length;
    if (memoCount > 0) return { ok: false, reason: "has_memos", category, memoCount };

    db.categories.splice(idx, 1);
    save(db);
    return { ok: true, category };
  }

  return {
    load,
    save,
    listCategories,
    addCategory,
    getCategoryByName,
    addMemo,
    queryMemos,
    deleteMemo,
    deleteCategory,
  };
}
