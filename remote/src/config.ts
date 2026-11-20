function required(name: string, minLength = 1): string {
  const v = process.env[name]?.trim();
  if (!v || v.length < minLength) {
    throw new Error(`${name} is required${minLength > 1 ? ` (at least ${minLength} chars)` : ""}`);
  }
  return v;
}

const publicUrl = (process.env.PUBLIC_URL?.trim() ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "")).replace(/\/+$/, "");
if (!publicUrl) throw new Error("PUBLIC_URL is required (or generate a Railway domain)");

export const config = {
  port: Number(process.env.PORT ?? 8080),
  publicUrl: new URL(publicUrl),
  mcpUrl: new URL(`${publicUrl}/mcp`),
  authSecret: required("AUTH_SECRET", 32),
  adminPassword: required("ADMIN_PASSWORD", 12),
  garminApiKey: required("GARMIN_PERSONAL_API_KEY"),
  garminDataDir: process.env.GARMIN_DATA_DIR?.trim() || "/tmp/garmin-data",
  allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS ?? "claude.ai,claude.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  hiddenTools: new Set(
    (process.env.HIDE_TOOLS ??
      "writeDashboard,editDashboard,scheduleDashboardRefresh,downloadActivityFit")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  scaleToken: process.env.SCALE_TOKEN?.trim() || undefined,
  scaleDataFile: process.env.SCALE_DATA_FILE?.trim() || "/data/scale.json",
  accessTokenTtlSec: Number(process.env.ACCESS_TOKEN_TTL_SEC ?? 3600),
  refreshTokenTtlSec: Number(process.env.REFRESH_TOKEN_TTL_SEC ?? 60 * 60 * 24 * 90),
};
