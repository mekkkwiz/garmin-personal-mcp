import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { config } from "./config.js";
import { Signer, safeEqual } from "./crypto.js";

export const SCOPE = "garmin.read";

type ClientMeta = Omit<OAuthClientInformationFull, "client_id" | "client_secret" | "client_secret_expires_at">;
interface TokenPayload {
  t: "access" | "refresh";
  cid: string;
  aud: string;
  exp: number;
  scp: string[];
  jti: string;
}
interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  expiresAt: number;
}

const now = () => Math.floor(Date.now() / 1000);
const signer = new Signer(config.authSecret);

/** Stateless client store: the client_id is the signed client metadata, so registrations survive restarts. */
class ClientsStore implements OAuthRegisteredClientsStore {
  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const meta = signer.verify<{ k: "client"; m: ClientMeta }>(clientId);
    if (meta?.k !== "client") return undefined;
    const isPublic = meta.m.token_endpoint_auth_method === "none";
    return {
      ...meta.m,
      client_id: clientId,
      ...(isPublic ? {} : { client_secret: signer.derive(`client-secret:${clientId}`), client_secret_expires_at: 0 }),
    };
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    for (const uri of client.redirect_uris) {
      const u = new URL(uri);
      const host = u.hostname.toLowerCase();
      const allowed = config.allowedRedirectHosts.some((h) => host === h || host.endsWith(`.${h}`));
      if (u.protocol !== "https:" || !allowed) {
        throw new InvalidClientMetadataError(`redirect_uri not allowed: ${uri}`);
      }
    }
    const { client_secret: _s, client_secret_expires_at: _e, ...meta } = client;
    const m: ClientMeta = { ...meta, client_id_issued_at: now() };
    const clientId = signer.sign({ k: "client", m });
    return this.getClient(clientId)!;
  }
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new ClientsStore();
  private readonly codes = new Map<string, PendingCode>();
  private readonly failures = new Map<string, { count: number; until: number }>();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const request = signer.sign({
      k: "authz",
      cid: client.client_id,
      ru: params.redirectUri,
      cc: params.codeChallenge,
      st: params.state,
      sc: params.scopes ?? [SCOPE],
      exp: now() + 600,
    });
    res.status(200).type("html").setHeader("Cache-Control", "no-store").send(consentPage(client, request));
  }

  /** POST /consent: checks the password, then redirects back to the client with a code. */
  async consent(req: Request, res: Response): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    const ip = req.ip ?? "unknown";
    const f = this.failures.get(ip);
    if (f && f.until > Date.now()) {
      res.status(429).type("text").send("Too many attempts. Try again later.");
      return;
    }
    const body = req.body as { request?: string; password?: string; action?: string };
    const r = signer.verify<{ k: string; cid: string; ru: string; cc: string; st?: string; sc: string[]; exp: number }>(
      body.request ?? "",
    );
    if (r?.k !== "authz" || r.exp < now() || !this.clientsStore.getClient(r.cid)) {
      res.status(400).type("text").send("Authorization request expired. Start again from Claude.");
      return;
    }
    const back = new URL(r.ru);
    if (r.st !== undefined) back.searchParams.set("state", r.st);

    if (body.action === "deny") {
      back.searchParams.set("error", "access_denied");
      res.redirect(302, back.href);
      return;
    }
    if (!safeEqual(body.password ?? "", config.adminPassword)) {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(ip, { count, until: count >= 5 ? Date.now() + 15 * 60_000 : 0 });
      console.warn(`[auth] wrong password from ${ip} (${count})`);
      await new Promise((ok) => setTimeout(ok, 1000));
      res.status(401).type("html").send(consentPage(this.clientsStore.getClient(r.cid)!, body.request!, "Wrong password"));
      return;
    }
    this.failures.delete(ip);
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: r.cid,
      redirectUri: r.ru,
      challenge: r.cc,
      scopes: r.sc,
      expiresAt: Date.now() + 5 * 60_000,
    });
    console.log(`[auth] code issued to ${clientName(this.clientsStore.getClient(r.cid)!)}`);
    back.searchParams.set("code", code);
    res.redirect(302, back.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("Invalid code");
    return c.challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const c = this.codes.get(code);
    this.codes.delete(code);
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("Invalid code");
    if (redirectUri !== undefined && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    return this.issue(client.client_id, c.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const p = signer.verify<TokenPayload>(refreshToken);
    if (p?.t !== "refresh" || p.cid !== client.client_id || p.exp < now() || p.aud !== config.mcpUrl.href) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    return this.issue(client.client_id, p.scp);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = signer.verify<TokenPayload>(token);
    if (p?.t !== "access" || p.exp < now()) throw new InvalidTokenError("Invalid or expired token");
    return { token, clientId: p.cid, scopes: p.scp, expiresAt: p.exp, resource: new URL(p.aud) };
  }

  private issue(clientId: string, scopes: string[]): OAuthTokens {
    const base = { cid: clientId, aud: config.mcpUrl.href, scp: scopes };
    const access = signer.sign({ ...base, t: "access", exp: now() + config.accessTokenTtlSec, jti: rand() });
    const refresh = signer.sign({ ...base, t: "refresh", exp: now() + config.refreshTokenTtlSec, jti: rand() });
    return {
      access_token: access,
      token_type: "bearer",
      expires_in: config.accessTokenTtlSec,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }

  sweep(): void {
    const t = Date.now();
    for (const [k, v] of this.codes) if (v.expiresAt < t) this.codes.delete(k);
    for (const [k, v] of this.failures) if (v.until < t && v.count >= 5) this.failures.delete(k);
  }
}

const rand = () => randomBytes(8).toString("base64url");
const clientName = (c: OAuthClientInformationFull) => c.client_name ?? new URL(c.redirect_uris[0]!).host;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function consentPage(client: OAuthClientInformationFull, request: string, error?: string): string {
  const redirectHost = new URL(client.redirect_uris[0]!).host;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Garmin MCP – authorize</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px;color:#222}
input,button{font:inherit;padding:10px;width:100%;box-sizing:border-box;margin-top:8px}
button{cursor:pointer}.err{color:#b00020}.muted{color:#666;font-size:.9em}</style></head><body>
<h2>Allow access to your Garmin data?</h2>
<p><b>${esc(clientName(client))}</b> (${esc(redirectHost)}) wants read-only access to sleep, HRV, activities, weight and other Garmin data.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/consent">
<input type="hidden" name="request" value="${esc(request)}">
<input type="password" name="password" placeholder="Admin password" autocomplete="current-password" autofocus required>
<button type="submit" name="action" value="allow">Allow</button>
</form>
<form method="post" action="/consent"><input type="hidden" name="request" value="${esc(request)}">
<button type="submit" name="action" value="deny" formnovalidate>Deny</button></form>
<p class="muted">Only continue if you started this from your own Claude account.</p>
</body></html>`;
}
