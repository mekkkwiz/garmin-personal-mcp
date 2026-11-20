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
| `SCALE_TOKEN` | – | Bearer token ของ `/api/scale` (ไม่ตั้ง = endpoint ตอบ 503) |
| `SCALE_DATA_FILE` | – | default `/data/scale.json` (Railway volume) |
| `HIDE_TOOLS` | – | comma-separated, override รายการ tool ที่ซ่อน |
| `ACCESS_TOKEN_TTL_SEC` / `REFRESH_TOKEN_TTL_SEC` | – | default 3600 / 90 วัน |

## Local

```bash
npm i && npm run build
PUBLIC_URL=http://localhost:8080 AUTH_SECRET=$(openssl rand -hex 32) ADMIN_PASSWORD=... GARMIN_PERSONAL_API_KEY=... npm start
```

## เพิ่มใน claude.ai

Settings → Connectors → Add custom connector → URL `https://<domain>/mcp` → Connect → ใส่ `ADMIN_PASSWORD` → Allow

## Scale API (ตาชั่ง → Apple Health → iPhone Shortcut)

`POST /api/scale` · `Authorization: Bearer $SCALE_TOKEN` · `Content-Type: application/json`

```json
{ "weight_kg": 96.4, "body_fat_pct": 30.2, "muscle_mass_kg": 63.1, "measured_at": "2026-11-20T08:05:00+07:00", "source": "shortcut" }
```

- รับเลขหรือ string (`"96,4 kg"`, `"30%"`); body fat แบบเศษส่วน (0.302) จะแปลงเป็น % ให้
- 1 แถวต่อวัน (เวลาไทย) ตาม `measured_at`; ค่าที่ชั่งทีหลังในวันเดียวกันจะแทนค่าเดิม ค่าที่เก่ากว่าจะไม่ทับ (`unchanged`)
- ตอบ `201 created` / `200 updated|unchanged` / `400` ข้อมูลผิด / `401` token ผิด

`GET /api/scale?from=yyyy-MM-dd&to=yyyy-MM-dd` (token เดียวกัน) ดูข้อมูลที่เก็บไว้

MCP tool: `getScaleWeight(fromDate?, toDate?)` default 30 วันล่าสุด
