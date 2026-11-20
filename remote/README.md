# garmin-mcp-remote

ห่อ [`@indaco/garmin-personal-mcp`](https://github.com/indaco/garmin-personal-mcp) (stdio, read-only) ให้เป็น **remote MCP (Streamable HTTP)** พร้อม **OAuth 2.1 แบบผู้ใช้คนเดียว** เพื่อเพิ่มเป็น custom connector ใน claude.ai

- `/mcp` ต้องมี Bearer token ทุก request (ไม่มี = 401)
- OAuth: Dynamic Client Registration + PKCE S256 + refresh token; ยอมรับ redirect เฉพาะ `claude.ai` / `claude.com`
- หน้า consent ต้องใส่ `ADMIN_PASSWORD` (ผิด 5 ครั้ง ล็อก IP 15 นาที)
- Token เป็น HMAC-signed (stateless) → redeploy แล้วไม่ต้อง login ใหม่; หมุน `AUTH_SECRET` = เพิกถอนทุก token ทันที
- ซ่อน tool ที่เขียนไฟล์/ตั้ง cron บน server (`writeDashboard, editDashboard, scheduleDashboardRefresh, downloadActivityFit`)

## Environment variables

| ชื่อ | จำเป็น | ค่า |
|---|---|---|
| `GARMIN_PERSONAL_API_KEY` | ✓ | key จาก https://connect.garmin.com/app/settings/personalApiToken |
| `ADMIN_PASSWORD` | ✓ | รหัสผ่านหน้า consent (≥12 ตัว) |
| `AUTH_SECRET` | ✓ | สุ่ม ≥32 ตัว (`openssl rand -hex 32`) |
| `PUBLIC_URL` | – | ไม่ใส่จะใช้ `RAILWAY_PUBLIC_DOMAIN` อัตโนมัติ |
| `HIDE_TOOLS` | – | comma-separated, override รายการ tool ที่ซ่อน |
| `ACCESS_TOKEN_TTL_SEC` / `REFRESH_TOKEN_TTL_SEC` | – | default 3600 / 90 วัน |

## Local

```bash
npm i && npm run build
PUBLIC_URL=http://localhost:8080 AUTH_SECRET=$(openssl rand -hex 32) ADMIN_PASSWORD=... GARMIN_PERSONAL_API_KEY=... npm start
```

## เพิ่มใน claude.ai

Settings → Connectors → Add custom connector → URL `https://<domain>/mcp` → Connect → ใส่ `ADMIN_PASSWORD` → Allow
