import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { GIGACHAD_INSTRUCTIONS } from "./persona/persona.js";

export interface HttpServerOptions {
  port: number;
  /** 매 요청마다 새 McpServer에 도구/페르소나를 등록하는 콜백 (stateless) */
  register: (server: McpServer) => void;
}

/**
 * PlayMCP 직등록형 Streamable HTTP 서버.
 * - POST /mcp : MCP 요청 (stateless — 요청마다 server+transport 생성)
 * - GET  /health : 헬스체크 (PlayMCP 등록 시 점검)
 */
export function startHttpServer(opts: HttpServerOptions): void {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok", bot: "CHAD" });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    try {
      const server = new McpServer(
        { name: "giga-chad-mcp", version: "0.1.0" },
        { instructions: GIGACHAD_INSTRUCTIONS },
      );
      opts.register(server);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless 모드
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[CHAD] MCP request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // stateless: GET(SSE 스트림)/DELETE(세션 종료) 미지원
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.listen(opts.port, () => {
    console.log(`[CHAD] MCP server listening on :${opts.port}  (POST /mcp · GET /health)`);
  });
}
