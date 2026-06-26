import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "../types.js";

// ============================================================================
// Stream C 구현: get_schedule (KST 기준 today/tomorrow/week 필터·정렬)
//
// KST approach:
//   Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }) produces a
//   "YYYY-MM-DD" calendar string in KST without any manual offset arithmetic.
//   Boundary Date objects are constructed via ISO strings with "+09:00" suffix
//   (e.g. "2026-06-27T00:00:00+09:00"), so the JS engine handles the
//   UTC-epoch conversion correctly in all environments.
// ============================================================================

// ---------- KST helpers ----------

/** Returns "YYYY-MM-DD" for the given UTC Date, expressed in KST. */
function getKstDateStr(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
}

/** KST midnight of the given KST date string as a UTC Date. */
function kstMidnight(kstDateStr: string): Date {
  return new Date(`${kstDateStr}T00:00:00+09:00`);
}

/** Add n calendar days (via KST midnight hop) and return new KST date string. */
function addKstDays(kstDateStr: string, n: number): string {
  const base = kstMidnight(kstDateStr);
  return getKstDateStr(new Date(base.getTime() + n * 86_400_000));
}

// ---------- Content parsing ----------

const KR_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;
const EN_WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

interface HM { hours: number; minutes: number }

/**
 * Extract the first time expression from text ("14시", "오후 6시", "6시30분", "14:30").
 * 오전/오후(및 am/pm)를 12시간제 보정한다: "오후 6시" → 18:00, "오전 12시" → 00:00.
 */
function extractTime(text: string): HM | null {
  let hours: number;
  let minutes: number;

  const siMatch = text.match(/(\d{1,2})시(?:\s*(\d{1,2})분)?/);
  if (siMatch) {
    hours = parseInt(siMatch[1], 10);
    minutes = siMatch[2] ? parseInt(siMatch[2], 10) : 0;
  } else {
    const colonMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (!colonMatch) return null;
    hours = parseInt(colonMatch[1], 10);
    minutes = parseInt(colonMatch[2], 10);
  }

  // 오전/오후(AM/PM) 보정
  const isPm = text.includes("오후") || /\b(pm|p\.m\.)\b/i.test(text);
  const isAm = text.includes("오전") || /\b(am|a\.m\.)\b/i.test(text);
  if (isPm && hours < 12) hours += 12;
  else if (isAm && hours === 12) hours = 0;

  return { hours, minutes };
}

/** Build a KST-anchored Date from a KST date string plus an optional time. */
function makeKstDate(kstDateStr: string, time: HM | null): Date {
  const t = time ?? { hours: 0, minutes: 0 };
  const hh = String(t.hours).padStart(2, "0");
  const mm = String(t.minutes).padStart(2, "0");
  return new Date(`${kstDateStr}T${hh}:${mm}:00+09:00`);
}

/**
 * Attempt to derive a concrete Date from memo content using a set of lightweight
 * patterns. Returns null when no confident match is found — caller places those
 * memos in the `unscheduled` bucket instead of guessing.
 *
 * Supported patterns (priority order):
 *   1. ISO date literal: "2026-06-30" or "2026-06-30T15:00" / "2026-06-30 15:00"
 *   2. 오늘 (today), 내일 (tomorrow) — combined with optional time expression
 *   3. M/D or M/D H:MM ("6/30", "6/30 15:00")
 *   4. Korean weekday names: "월요일", "화요일", … (next occurrence from today)
 *   5. English weekday names: "Monday", "Tuesday", …
 *   6. Time-only ("14시", "15:00") — assumed to be today
 */
function parseKstDateTime(content: string, todayKstStr: string): Date | null {
  const lower = content.toLowerCase();
  const time = extractTime(content);

  // 1. ISO date literal
  const isoMatch = content.match(/(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/);
  if (isoMatch) {
    const dateStr = isoMatch[1];
    if (isoMatch[2]) {
      return new Date(`${dateStr}T${isoMatch[2]}:00+09:00`);
    }
    return makeKstDate(dateStr, time);
  }

  // 2. 오늘 / 내일
  if (content.includes("오늘")) {
    return makeKstDate(todayKstStr, time);
  }
  if (content.includes("내일")) {
    return makeKstDate(addKstDays(todayKstStr, 1), time);
  }

  // 3. M/D or M/D H:MM (assume current KST year)
  const slashMatch = content.match(/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (slashMatch) {
    const kstYear = todayKstStr.slice(0, 4);
    const month = String(parseInt(slashMatch[1], 10)).padStart(2, "0");
    const day = String(parseInt(slashMatch[2], 10)).padStart(2, "0");
    const dateStr = `${kstYear}-${month}-${day}`;
    if (slashMatch[3] && slashMatch[4]) {
      const h = String(parseInt(slashMatch[3], 10)).padStart(2, "0");
      return new Date(`${dateStr}T${h}:${slashMatch[4]}:00+09:00`);
    }
    return makeKstDate(dateStr, time);
  }

  // 4. Korean weekday names ("월요일", "화요일", …)
  const todayDow = kstMidnight(todayKstStr).getDay(); // 0=Sun … 6=Sat
  for (let i = 0; i < KR_WEEKDAYS.length; i++) {
    if (content.includes(KR_WEEKDAYS[i] + "요일")) {
      let diff = i - todayDow;
      if (diff <= 0) diff += 7; // always future
      return makeKstDate(addKstDays(todayKstStr, diff), time);
    }
  }

  // 5. English weekday names
  for (let i = 0; i < EN_WEEKDAYS.length; i++) {
    if (lower.includes(EN_WEEKDAYS[i])) {
      let diff = i - todayDow;
      if (diff <= 0) diff += 7;
      return makeKstDate(addKstDays(todayKstStr, diff), time);
    }
  }

  // 6. Time-only → assume today
  if (time !== null) {
    return makeKstDate(todayKstStr, time);
  }

  return null;
}

// ---------- Status ----------

function getStatus(when: Date, now: Date): "지남" | "진행/임박" | "예정" {
  const diffMs = when.getTime() - now.getTime();
  const thirtyMin = 30 * 60 * 1000;
  if (diffMs < -thirtyMin) return "지남";
  if (diffMs <= thirtyMin) return "진행/임박";
  return "예정";
}

// ---------- Tool registration ----------

export function registerScheduleTools(server: McpServer, ctx: ToolCtx): void {
  server.registerTool(
    "get_schedule",
    {
      title: "일정 조회",
      description:
        "KST 기준으로 오늘(today)/내일(tomorrow)/이번 주(week) 일정 메모를 조회하고 시간순으로 정렬해 반환합니다. " +
        "응답 JSON을 기반으로 호스트 LLM이 자연어 요약을 생성하세요.",
      inputSchema: {
        range: z.enum(["today", "tomorrow", "week"]),
      },
    },
    async (args) => {
      try {
        const { range } = args as { range: "today" | "tomorrow" | "week" };
        const nowUtc = new Date();

        // KST 달력 날짜 문자열
        const todayKstStr = getKstDateStr(nowUtc);
        const tomorrowKstStr = addKstDays(todayKstStr, 1);

        // Range UTC boundaries
        let rangeStart: Date;
        let rangeEnd: Date;

        if (range === "today") {
          rangeStart = kstMidnight(todayKstStr);
          rangeEnd = kstMidnight(tomorrowKstStr);
        } else if (range === "tomorrow") {
          rangeStart = kstMidnight(tomorrowKstStr);
          rangeEnd = kstMidnight(addKstDays(tomorrowKstStr, 1));
        } else {
          // week: nowUtc → nowUtc + 7 days
          rangeStart = nowUtc;
          rangeEnd = new Date(nowUtc.getTime() + 7 * 86_400_000);
        }

        const memos = ctx.store.queryMemos({ categoryId: "schedule" });

        const items: Array<{
          id: string;
          content: string;
          when: string;
          status: "지남" | "진행/임박" | "예정";
        }> = [];
        const unscheduled: Array<{ id: string; content: string }> = [];

        for (const memo of memos) {
          let when: Date | null = null;

          // Prefer meta.startAt (ISO string)
          const startAt = memo.meta?.startAt;
          if (typeof startAt === "string") {
            const parsed = new Date(startAt);
            if (!isNaN(parsed.getTime())) {
              when = parsed;
            }
          }

          // Fall back to content parsing
          if (when === null) {
            when = parseKstDateTime(memo.content, todayKstStr);
          }

          // No parseable datetime → unscheduled
          if (when === null) {
            unscheduled.push({ id: memo.id, content: memo.content });
            continue;
          }

          // Only include memos whose datetime falls in the requested range
          if (when >= rangeStart && when < rangeEnd) {
            items.push({
              id: memo.id,
              content: memo.content,
              when: when.toISOString(),
              status: getStatus(when, nowUtc),
            });
          }
          // Memos with a valid datetime outside the range are silently omitted
          // (not unscheduled — they have a real time, just not the requested window)
        }

        // Sort ascending by datetime string (ISO strings sort lexicographically)
        items.sort((a, b) => a.when.localeCompare(b.when));

        const inProgressOrUpcoming = items
          .filter((it) => it.status === "진행/임박" || it.status === "예정")
          .map(({ id, content, when }) => ({ id, content, when }));

        // now_kst: shift UTC epoch by +9h and emit with +09:00 suffix
        const nowKstIso =
          new Date(nowUtc.getTime() + 9 * 3_600_000)
            .toISOString()
            .replace("Z", "+09:00");

        const result = {
          now_kst: nowKstIso,
          range,
          inProgressOrUpcoming,
          items,
          unscheduled,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `오류: ${msg}` }],
        };
      }
    },
  );
}
