import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { SCOPE, SingleUserOAuthProvider } from "./oauth.js";
import { createProxyServer, getUpstream } from "./proxy.js";

const provider = new SingleUserOAuthProvider();
setInterval(() => provider.sweep(), 60_000).unref();

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: config.publicUrl,
    resourceServerUrl: config.mcpUrl,
    scopesSupported: [SCOPE],
    resourceName: "Garmin Personal MCP",
    clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0 },
  }),
);

app.post("/consent", express.urlencoded({ extended: false, limit: "16kb" }), (req, res, next) => {
  provider.consent(req, res).catch(next);
});

const bearer = requireBearerAuth({
  verifier: provider,
  requiredScopes: [SCOPE],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  expectedResource: config.mcpUrl,
});

app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
  try {
    const server = await createProxyServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp]", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
});

const methodNotAllowed: express.RequestHandler = (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
};
app.get("/mcp", bearer, methodNotAllowed);
app.delete("/mcp", bearer, methodNotAllowed);

app.listen(config.port, () => {
  console.log(`[http] listening on :${config.port}, MCP endpoint ${config.mcpUrl.href}`);
  getUpstream().catch((e) => console.error("[upstream] failed to start", e));
});
