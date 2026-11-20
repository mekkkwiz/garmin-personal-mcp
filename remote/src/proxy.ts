import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { config } from "./config.js";
import { callScaleTool, scaleTool } from "./scale.js";

const require = createRequire(import.meta.url);
const garminEntry = require.resolve("@indaco/garmin-personal-mcp/dist/index.js");
const TIMEOUT = { timeout: 180_000 };

let upstream: Promise<Client> | undefined;

/** One shared stdio child for all HTTP sessions; restarted lazily if it exits. */
export function getUpstream(): Promise<Client> {
  upstream ??= (async () => {
    mkdirSync(config.garminDataDir, { recursive: true });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [garminEntry],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "/tmp",
        TZ: process.env.TZ ?? "Asia/Bangkok",
        GARMIN_PERSONAL_API_KEY: config.garminApiKey,
        GARMIN_DATA_DIR: config.garminDataDir,
      },
      stderr: "inherit",
    });
    const client = new Client({ name: "garmin-remote-proxy", version: "1.0.0" });
    client.onclose = () => {
      console.warn("[upstream] garmin-personal-mcp exited; will restart on next request");
      upstream = undefined;
    };
    try {
      await client.connect(transport);
    } catch (e) {
      upstream = undefined;
      throw e;
    }
    console.log("[upstream] connected", client.getServerVersion());
    return client;
  })();
  return upstream;
}

/** A fresh MCP server (one per HTTP request, stateless) that forwards to the shared upstream. */
export async function createProxyServer(): Promise<Server> {
  const up = await getUpstream();
  const caps = up.getServerCapabilities() ?? {};
  const capabilities: ServerCapabilities = {
    tools: {},
    ...(caps.prompts ? { prompts: {} } : {}),
    ...(caps.resources ? { resources: {} } : {}),
  };
  const info = up.getServerVersion();
  const server = new Server(
    { name: info?.name ?? "garmin-personal", version: info?.version ?? "0" },
    { capabilities, instructions: up.getInstructions() },
  );

  {
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const r = await up.listTools(req.params, TIMEOUT);
      const tools = r.tools.filter((t) => !config.hiddenTools.has(t.name));
      return { ...r, tools: req.params?.cursor ? tools : [scaleTool, ...tools] };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      if (req.params.name === scaleTool.name) return callScaleTool(req.params.arguments);
      if (config.hiddenTools.has(req.params.name)) {
        throw new McpError(ErrorCode.InvalidParams, `Tool ${req.params.name} is disabled on this server`);
      }
      return up.callTool(req.params, undefined, TIMEOUT);
    });
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, (req) => up.listPrompts(req.params, TIMEOUT));
    server.setRequestHandler(GetPromptRequestSchema, (req) => up.getPrompt(req.params, TIMEOUT));
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, (req) => up.listResources(req.params, TIMEOUT));
    server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) =>
      up.listResourceTemplates(req.params, TIMEOUT),
    );
    server.setRequestHandler(ReadResourceRequestSchema, (req) => up.readResource(req.params, TIMEOUT));
  }
  return server;
}
