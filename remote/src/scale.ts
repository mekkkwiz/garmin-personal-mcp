import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response } from "express";
import { config } from "./config.js";
import { safeEqual } from "./crypto.js";

export interface ScaleEntry {
  date: string; // yyyy-MM-dd, local (TZ)
  measuredAt: string; // ISO 8601
  weightKg: number;
  bodyFatPct?: number;
  muscleMassKg?: number;
  source?: string;
  receivedAt: string;
}

type Store = Record<string, ScaleEntry>;

const TZ = process.env.TZ || "Asia/Bangkok";
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let cache: Store | undefined;

function load(): Store {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(config.scaleDataFile, "utf8")) as Store;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    cache = {};
  }
  return cache;
}

function save(store: Store): void {
  mkdirSync(dirname(config.scaleDataFile), { recursive: true });
  const tmp = `${config.scaleDataFile}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, config.scaleDataFile);
  cache = store;
}

/** Accepts numbers or strings like "96.4", "96,4 kg", "25%". */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(",", ".").replace(/[^\d.+-eE]/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function parseWhen(v: unknown): Date {
  if (typeof v === "string" && v.trim()) {
    const s = v.trim();
    const d = DATE_RE.test(s) ? new Date(`${s}T12:00:00`) : new Date(s);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

class BadInput extends Error {}

export function normalize(body: Record<string, unknown>): Omit<ScaleEntry, "receivedAt"> {
  const weightKg = num(body.weight_kg ?? body.weight);
  if (weightKg === undefined || weightKg < 20 || weightKg > 300) throw new BadInput("weight_kg must be a number between 20 and 300");
  let bodyFatPct = num(body.body_fat_pct ?? body.body_fat);
  if (bodyFatPct !== undefined && bodyFatPct > 0 && bodyFatPct <= 1) bodyFatPct *= 100; // Health gives a fraction
  if (bodyFatPct !== undefined && (bodyFatPct <= 0 || bodyFatPct >= 80)) throw new BadInput("body_fat_pct out of range");
  const muscleMassKg = num(body.muscle_mass_kg ?? body.muscle_mass);
  if (muscleMassKg !== undefined && (muscleMassKg <= 0 || muscleMassKg >= weightKg)) throw new BadInput("muscle_mass_kg out of range");
  const when = parseWhen(body.measured_at ?? body.date);
  const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
  return {
    date: dateFmt.format(when),
    measuredAt: when.toISOString(),
    weightKg: round(weightKg, 2),
    ...(bodyFatPct !== undefined ? { bodyFatPct: round(bodyFatPct, 1) } : {}),
    ...(muscleMassKg !== undefined ? { muscleMassKg: round(muscleMassKg, 2) } : {}),
    ...(typeof body.source === "string" ? { source: body.source.slice(0, 64) } : {}),
  };
}

/** One entry per local date; a later measurement on the same date replaces an earlier one. */
export function upsert(entry: Omit<ScaleEntry, "receivedAt">): { action: "created" | "updated" | "unchanged"; entry: ScaleEntry } {
  const store = { ...load() };
  const prev = store[entry.date];
  if (prev && prev.measuredAt > entry.measuredAt) return { action: "unchanged", entry: prev };
  const next: ScaleEntry = { ...entry, receivedAt: new Date().toISOString() };
  store[entry.date] = next;
  save(store);
  return { action: prev ? "updated" : "created", entry: next };
}

export function range(from?: string, to?: string): ScaleEntry[] {
  return Object.values(load())
    .filter((e) => (!from || e.date >= from) && (!to || e.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function requireScaleToken(req: Request, res: Response, next: () => void): void {
  if (!config.scaleToken) {
    res.status(503).json({ ok: false, error: "SCALE_TOKEN is not configured" });
    return;
  }
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!m || !safeEqual(m[1]!.trim(), config.scaleToken)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }
  next();
}

export function postScale(req: Request, res: Response): void {
  try {
    const result = upsert(normalize((req.body ?? {}) as Record<string, unknown>));
    console.log(`[scale] ${result.action} ${result.entry.date} ${result.entry.weightKg}kg`);
    res.status(result.action === "created" ? 201 : 200).json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof BadInput) {
      res.status(400).json({ ok: false, error: e.message });
      return;
    }
    console.error("[scale]", e);
    res.status(500).json({ ok: false, error: "internal error" });
  }
}

export function getScale(req: Request, res: Response): void {
  const from = typeof req.query.from === "string" && DATE_RE.test(req.query.from) ? req.query.from : undefined;
  const to = typeof req.query.to === "string" && DATE_RE.test(req.query.to) ? req.query.to : undefined;
  res.json({ ok: true, entries: range(from, to) });
}

export const scaleTool = {
  name: "getScaleWeight",
  title: "Scale weight (Xiaomi via Apple Health)",
  description:
    "Daily weigh-ins from the user's Xiaomi smart scale (sent from Apple Health by an iPhone Shortcut), one row per local date (Asia/Bangkok): date, weightKg, bodyFatPct and muscleMassKg when the scale measured them, measuredAt (ISO). Use this, not getWeight, for body weight and body fat: Garmin has no weigh-ins for this user. Dates yyyy-MM-dd; both optional (default: the last 30 days).",
  inputSchema: {
    type: "object" as const,
    properties: {
      fromDate: { type: "string", description: "First date yyyy-MM-dd" },
      toDate: { type: "string", description: "Last date yyyy-MM-dd" },
    },
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export function callScaleTool(args: Record<string, unknown> | undefined) {
  const today = dateFmt.format(new Date());
  const from = typeof args?.fromDate === "string" && DATE_RE.test(args.fromDate)
    ? args.fromDate
    : dateFmt.format(new Date(Date.now() - 29 * 86_400_000));
  const to = typeof args?.toDate === "string" && DATE_RE.test(args.toDate) ? args.toDate : today;
  const entries = range(from, to).map(({ receivedAt: _r, ...e }) => e);
  return { content: [{ type: "text" as const, text: JSON.stringify({ fromDate: from, toDate: to, count: entries.length, entries }) }] };
}
