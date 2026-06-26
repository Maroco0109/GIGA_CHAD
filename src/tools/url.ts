import { z } from "zod";
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

export function registerUrlTools(server: McpServer, _ctx: ToolCtx): void {
  server.registerTool(
    "analyze_url",
    {
      title: "URL 분석",
      description:
        "주어진 URL을 가져와 제목, 설명, 본문 발췌문을 추출하고 장소·정보·상품 중 하나로 분류합니다. " +
        "호스트 LLM이 요약·판단에 활용할 원시 메타데이터를 반환합니다.",
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
          response = await fetch(inputUrl, {
            signal: controller.signal,
            redirect: "follow",
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
