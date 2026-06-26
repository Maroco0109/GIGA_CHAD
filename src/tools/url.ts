import { z } from "zod";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCtx } from "../types.js";

// ============================================================================
// analyze_url — fetch a URL and extract metadata + heuristic classification
// ============================================================================

const MAX_BYTES = 200_000; // ~200 KB cap
const TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

type SuggestedClass = "장소" | "정보" | "상품";

/** Strip HTML tags, collapse whitespace, return first `maxLen` chars. */
function extractExcerpt(html: string, maxLen = 500): string {
  // Remove <script>, <style>, <head> and their content
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Strip remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode common entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  return text.slice(0, maxLen);
}

/** Extract <title> content, with og:title fallback. */
function extractTitle(html: string): string {
  // Try <title> tag first
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].replace(/\s+/g, " ").trim();
  }
  // og:title fallback
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i
  );
  return ogMatch ? ogMatch[1].trim() : "";
}

/** Extract meta description (name="description" or og:description). */
function extractDescription(html: string): string {
  // name="description"
  const descMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  if (descMatch) return descMatch[1].trim();

  // og:description
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
  return ogMatch ? ogMatch[1].trim() : "";
}

/** Classify the URL + text into one of three categories. */
function classify(url: string, host: string, bodyText: string): SuggestedClass {
  const urlLower = url.toLowerCase();
  const hostLower = host.toLowerCase();
  const combined = urlLower + " " + hostLower;

  // 장소 heuristics
  const placeHosts = ["map.naver", "map.kakao", "maps.google"];
  const placeUrlPatterns = ["/place/", "지도"];
  if (
    placeHosts.some((h) => combined.includes(h)) ||
    placeUrlPatterns.some((p) => combined.includes(p))
  ) {
    return "장소";
  }

  // 상품 heuristics
  const shopHosts = [
    "shopping",
    "danawa",
    "coupang",
    "smartstore",
    "amazon",
    "aliexpress",
  ];
  const shopUrlPatterns = ["/product", "/item", "/goods"];
  const pricePattern = /[₩$\d,]+\s*(원|USD|\$)/;
  if (
    shopHosts.some((h) => combined.includes(h)) ||
    shopUrlPatterns.some((p) => urlLower.includes(p)) ||
    pricePattern.test(bodyText.slice(0, 2000))
  ) {
    return "상품";
  }

  return "정보";
}

// ============================================================================
// SSRF 가드 — http/https만 허용, 사설·루프백·링크로컬 IP 차단, 리다이렉트 수동 검증
// ============================================================================

const REDIRECT_LIMIT = 5;

function ipv4Parts(ip: string): number[] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((n) => n > 255) ? null : p;
}

function isPrivateIp(ipRaw: string): boolean {
  // IPv4-mapped IPv6 (예: ::ffff:127.0.0.1) → v4로 환원
  const mapped = ipRaw.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const ip = mapped ? mapped[1] : ipRaw;

  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, loopback
    if (a === 169 && b === 254) return true; // 링크로컬/메타데이터 169.254/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }

  const lo = ip.toLowerCase();
  if (lo === "::1" || lo === "::") return true; // 루프백/미지정
  if (/^fe[89ab]/.test(lo)) return true; // 링크로컬 fe80::/10
  if (/^f[cd]/.test(lo)) return true; // ULA fc00::/7
  return false;
}

/** URL이 공개 대상인지 검증. 위반 시 throw. */
async function assertPublicUrl(urlStr: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked protocol: ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, ""); // IPv6 대괄호 제거
  const lo = host.toLowerCase();
  if (
    lo === "localhost" ||
    lo.endsWith(".localhost") ||
    lo.endsWith(".local") ||
    lo.endsWith(".internal")
  ) {
    throw new Error("blocked host: local");
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error("blocked private IP");
    return;
  }
  const addrs = await lookup(host, { all: true });
  if (addrs.length === 0) throw new Error("DNS resolution failed");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error(`blocked private IP (resolved ${a.address})`);
    }
  }
}

/** SSRF-safe fetch: 수동 리다이렉트 + 각 홉 검증. */
async function safeFetch(startUrl: string, init: RequestInit): Promise<Response> {
  let current = startUrl;
  for (let i = 0; i <= REDIRECT_LIMIT; i++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: "manual" });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error("too many redirects");
}

export function registerUrlTools(server: McpServer, _ctx: ToolCtx): void {
  server.registerTool(
    "analyze_url",
    {
      title: "URL 분석",
      description:
        "주어진 URL을 가져와 제목, 설명, 본문 발췌문을 추출하고 장소·정보·상품 중 하나로 분류합니다. " +
        "호스트 LLM이 요약·판단에 활용할 원시 메타데이터를 반환합니다. " +
        "이 도구는 분석만 하며 저장하지 않습니다 — 삣삐가 링크를 정리·저장·기억해달라고 하면 " +
        "분석 후 반드시 save_memo로 그 URL을 저장하세요(분류 결과를 카테고리로 활용).",
      inputSchema: {
        url: z.string().url().describe("분석할 URL"),
      },
    },
    async (args) => {
      const inputUrl: string = args.url;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        let response: Response;
        try {
          response = await safeFetch(inputUrl, {
            signal: controller.signal,
            headers: { "User-Agent": USER_AGENT },
          });
        } finally {
          clearTimeout(timer);
        }

        const finalUrl = response.url ?? inputUrl;
        const status = response.status;

        if (!response.ok) {
          const finalHost = new URL(finalUrl).hostname;
          const result = {
            url: inputUrl,
            finalUrl,
            status,
            error: `HTTP ${status}`,
            suggestedClass: classify(finalUrl, finalHost, "") as SuggestedClass,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        }

        // Read body with byte cap
        const reader = response.body?.getReader();
        let html = "";
        if (reader) {
          const decoder = new TextDecoder();
          let totalBytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.byteLength;
            html += decoder.decode(value, { stream: true });
            if (totalBytes >= MAX_BYTES) {
              await reader.cancel();
              break;
            }
          }
        } else {
          html = await response.text();
          if (html.length > MAX_BYTES) html = html.slice(0, MAX_BYTES);
        }

        const finalHost = (() => {
          try {
            return new URL(finalUrl).hostname;
          } catch {
            return "";
          }
        })();

        const title = extractTitle(html);
        const description = extractDescription(html);
        const excerpt = extractExcerpt(html);
        const suggestedClass = classify(finalUrl, finalHost, excerpt);

        const result = {
          url: inputUrl,
          finalUrl,
          status,
          title,
          description,
          suggestedClass,
          excerpt,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (err: unknown) {
        const errorMsg =
          err instanceof Error
            ? err.name === "AbortError"
              ? "Request timed out after 8 seconds"
              : err.message
            : String(err);

        const result = {
          url: inputUrl,
          error: errorMsg,
          suggestedClass: "정보" as SuggestedClass,
        };

        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
    }
  );
}
