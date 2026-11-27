import { escapeHtml } from "./shared";
import type { AdminSectionConfig, PageVisit } from "./types";

type SupabaseClientLike = any;

interface AdminStatsOptions {
  $: (id: string) => HTMLElement | null;
  setText: (id: string, text: string) => void;
  getClient: () => SupabaseClientLike | null;
  getSection: () => AdminSectionConfig;
}

interface StatsRow {
  label: string;
  value: string;
  hint?: string;
  percent?: number;
}

interface SessionStats {
  sessionId: string;
  visits: PageVisit[];
  firstSeen: Date;
  periodVisits: PageVisit[];
}

interface PeriodRange {
  start: Date | null;
  end: Date;
  lookupDays: number | null;
  chartDays: number;
}

const VISIT_PAGE_SIZE = 1000;
const VISIT_MAX_PAGES = 250;
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function requiredElement<T extends HTMLElement>(lookup: (id: string) => HTMLElement | null, id: string): T {
  const element = lookup(id);
  if (!element) throw new Error(`Missing admin stats element: ${id}`);
  return element as T;
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatStatsDate(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "";

  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDayLabel(value: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(new Date(`${value}T12:00:00`));
  } catch {
    return value;
  }
}

function countBy<T>(items: T[], getKey: (item: T) => string): Map<string, number> {
  const map = new Map<string, number>();
  items.forEach((item) => {
    const key = getKey(item).trim() || "Не определено";
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

function topRows(map: Map<string, number>, limit = 10, total?: number): StatsRow[] {
  const denominator = total || Array.from(map.values()).reduce((sum, value) => sum + value, 0) || 1;
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, value]) => ({
      label,
      value: String(value),
      percent: Math.round((value / denominator) * 100)
    }));
}

function externalReferrer(referrer: string | null): string {
  if (!referrer) return "Прямой вход";
  try {
    const url = new URL(referrer);
    if (url.hostname === window.location.hostname) return "Внутренний переход";
    return url.hostname.replace(/^www\./, "");
  } catch {
    return referrer.slice(0, 80);
  }
}

function pageLabel(path: string | null | undefined, key: string | null | undefined): string {
  const value = path || key || "unknown";
  return value === "/" ? "/ index" : value;
}

function sessionKey(visit: PageVisit): string {
  return visit.session_id || visit.visitor_id || visit.id;
}

function isPublicVisit(visit: PageVisit): boolean {
  return visit.page_path !== "/admin.html";
}

function isAutomatedVisit(visit: PageVisit): boolean {
  return /bot|crawler|spider|headless|lighthouse|preview|facebookexternalhit/i.test(visit.user_agent || "");
}

function visitorKey(visit: PageVisit): string {
  return visit.visitor_id || visit.session_id || visit.id;
}

function isVisitInRange(visit: PageVisit, start: Date | null, end: Date): boolean {
  const created = parseDate(visit.created_at);
  if (!created) return false;
  return (!start || created >= start) && created < end;
}

function buildSessions(visits: PageVisit[], periodStart: Date | null, periodEnd: Date): SessionStats[] {
  const grouped = new Map<string, PageVisit[]>();
  visits.forEach((visit) => {
    const key = sessionKey(visit);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)?.push(visit);
  });

  return Array.from(grouped.entries()).flatMap(([baseSessionId, sessionVisits]) => {
    const sorted = sessionVisits
      .slice()
      .sort((a, b) => (parseDate(a.created_at)?.getTime() || 0) - (parseDate(b.created_at)?.getTime() || 0));
    const chunks: PageVisit[][] = [];
    sorted.forEach((visit) => {
      const current = chunks[chunks.length - 1];
      const previousTime = current?.length ? parseDate(current[current.length - 1].created_at)?.getTime() : null;
      const currentTime = parseDate(visit.created_at)?.getTime();
      if (!current || !previousTime || !currentTime || currentTime - previousTime > SESSION_TIMEOUT_MS) chunks.push([visit]);
      else current.push(visit);
    });

    return chunks.map((chunk, index) => {
      const firstKnown = chunk[0];
      const explicitFirstSeen = parseDate(firstKnown?.first_seen_at || null);
      const firstSeen = explicitFirstSeen || parseDate(firstKnown?.created_at) || new Date();
      const periodVisits = chunk.filter((visit) => isVisitInRange(visit, periodStart, periodEnd));
      return { sessionId: `${baseSessionId}:${index}`, visits: chunk, firstSeen, periodVisits };
    });
  });
}

function renderRows(targetId: string, rows: StatsRow[], emptyText: string): void {
  const target = document.getElementById(targetId);
  if (!target) return;

  if (!rows.length) {
    target.innerHTML = `<div class="admin-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }

  target.innerHTML = rows.map((row) => `
    <div class="stats-row">
      <span>${escapeHtml(row.label)}${row.hint ? `<small>${escapeHtml(row.hint)}</small>` : ""}</span>
      <strong>${escapeHtml(row.value)}</strong>
      ${typeof row.percent === "number" ? `<i style="--bar:${Math.max(2, Math.min(100, row.percent))}%"></i>` : ""}
    </div>
  `).join("");
}

function renderDailyChart(targetId: string, visits: PageVisit[], days: number): void {
  const target = document.getElementById(targetId);
  if (!target) return;

  const today = new Date();
  const buckets = new Map<string, number>();
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - index);
    buckets.set(dayKey(date), 0);
  }

  visits.forEach((visit) => {
    const created = parseDate(visit.created_at);
    if (!created) return;
    const key = dayKey(created);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) || 0) + 1);
  });

  const max = Math.max(...Array.from(buckets.values()), 1);
  target.innerHTML = Array.from(buckets.entries()).map(([date, value]) => `
    <div class="stats-day" title="${escapeHtml(formatDayLabel(date))}: ${value}">
      <span style="height:${Math.max(4, Math.round((value / max) * 100))}%"></span>
      <small>${escapeHtml(formatDayLabel(date))}</small>
    </div>
  `).join("");
}

async function fetchVisits(client: SupabaseClientLike, start: Date | null): Promise<PageVisit[]> {
  const visits: PageVisit[] = [];

  for (let page = 0; page < VISIT_MAX_PAGES; page += 1) {
    const from = page * VISIT_PAGE_SIZE;
    const to = from + VISIT_PAGE_SIZE - 1;
    let query = client
      .from("page_visits")
      .select("*")
      .neq("page_path", "/admin.html")
      .order("created_at", { ascending: false })
      .range(from, to);

    if (start) query = query.gte("created_at", start.toISOString());

    const { data, error } = await query;
    if (error) throw error;

    const pageVisits = ((data || []) as PageVisit[]).filter(isPublicVisit);
    visits.push(...pageVisits);

    if (!data || data.length < VISIT_PAGE_SIZE) break;
  }

  return visits;
}

export function createAdminStats(options: AdminStatsOptions) {
  const selectedPeriod = (): PeriodRange => {
    const select = options.$("stats-period-select") as HTMLSelectElement | null;
    const raw = select?.value || "30";
    const now = new Date();

    if (raw === "today") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { start, end: now, lookupDays: 180, chartDays: 7 };
    }

    if (raw === "yesterday") {
      const end = new Date(now);
      end.setHours(0, 0, 0, 0);
      const start = new Date(end);
      start.setDate(start.getDate() - 1);
      return { start, end, lookupDays: 180, chartDays: 7 };
    }

    if (raw === "all") return { start: null, end: now, lookupDays: null, chartDays: 30 };

    const value = Number(raw);
    const days = [7, 30, 90, 180].includes(value) ? value : 30;
    const start = new Date(now);
    start.setDate(start.getDate() - days);
    return { start, end: now, lookupDays: Math.max(days, 180), chartDays: Math.min(days, 30) };
  };

  const load = async (): Promise<void> => {
    const client = options.getClient();
    if (!client || !options.getSection().statsManager) return;

    const { start: periodStart, end: periodEnd, lookupDays, chartDays } = selectedPeriod();
    const lookupStart = lookupDays ? new Date() : null;
    if (lookupStart) lookupStart.setDate(lookupStart.getDate() - lookupDays);

    let allVisits: PageVisit[] = [];
    try {
      allVisits = (await fetchVisits(client, lookupStart)).filter((visit) => !isAutomatedVisit(visit));
    } catch (error) {
      const message = error instanceof Error ? error.message : "неизвестная ошибка";
      options.setText("editor-status", `Ошибка чтения статистики: ${message}`);
      ["stats-top-pages", "stats-recent", "stats-countries", "stats-referrers", "stats-devices", "stats-languages", "stats-entry-pages"].forEach((id) => {
        renderRows(id, [], "Статистика пока недоступна.");
      });
      return;
    }

    const periodVisits = allVisits.filter((visit) => isVisitInRange(visit, periodStart, periodEnd));
    const periodVisitCount = periodVisits.length;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayVisitCount = allVisits.filter((visit) => isVisitInRange(visit, todayStart, new Date())).length;
    const sessions = buildSessions(allVisits, periodStart, periodEnd).filter((session) => session.periodVisits.length > 0);
    const uniqueSessions = sessions.length;
    const periodVisitors = new Map<string, PageVisit[]>();
    periodVisits.forEach((visit) => {
      const key = visitorKey(visit);
      if (!periodVisitors.has(key)) periodVisitors.set(key, []);
      periodVisitors.get(key)?.push(visit);
    });
    let newVisitors = 0;
    let returningVisitors = 0;
    periodVisitors.forEach((visits) => {
      const firstSeen = parseDate(visits[0]?.first_seen_at) || parseDate(visits[visits.length - 1]?.created_at);
      if (!periodStart || (firstSeen && firstSeen >= periodStart && firstSeen < periodEnd)) newVisitors += 1;
      else returningVisitors += 1;
    });
    const bouncedSessions = sessions.filter((session) => session.periodVisits.length <= 1).length;
    const onlineSince = new Date(Date.now() - 5 * 60 * 1000);
    const onlineVisitors = new Set(periodVisits.filter((visit) => {
      const created = parseDate(visit.created_at);
      return created ? created >= onlineSince : false;
    }).map(visitorKey));

    const topPages = topRows(countBy(periodVisits, (visit) => pageLabel(visit.page_path, visit.page_key)), 10, periodVisitCount);
    const knownCountryVisits = periodVisits.filter((visit) => Boolean(visit.country_code || visit.country_name));
    const unknownCountryCount = periodVisitCount - knownCountryVisits.length;
    const countryRows = topRows(countBy(knownCountryVisits, (visit) => visit.country_name || visit.country_code || ""), 10, knownCountryVisits.length);
    const referrerRows = topRows(countBy(periodVisits, (visit) => externalReferrer(visit.referrer)), 10, periodVisitCount);
    const deviceRows = topRows(countBy(periodVisits, (visit) => visit.device_type || "Не определено"), 8, periodVisitCount);
    const languageRows = topRows(countBy(periodVisits, (visit) => visit.visitor_language || visit.language || "Не определено"), 8, periodVisitCount);
    const entryRows = topRows(countBy(sessions, (session) => {
      const firstPeriodVisit = session.periodVisits[0];
      return firstPeriodVisit?.landing_page || pageLabel(firstPeriodVisit?.page_path, firstPeriodVisit?.page_key);
    }), 10, uniqueSessions);

    const recent = periodVisits.slice(0, 14).map((visit) => ({
      label: pageLabel(visit.page_path, visit.page_key),
      value: formatStatsDate(visit.created_at),
      hint: [visit.country_name, visit.device_type, visit.browser_name].filter(Boolean).join(" · ")
    }));

    options.setText("stats-today", String(todayVisitCount));
    options.setText("stats-total", String(periodVisitCount));
    options.setText("stats-unique", String(uniqueSessions));
    options.setText("stats-online", String(onlineVisitors.size));
    options.setText("stats-new", String(newVisitors));
    options.setText("stats-returning", String(returningVisitors));
    options.setText("stats-bounce", String(bouncedSessions));
    options.setText("stats-bounce-rate", `${uniqueSessions ? Math.round((bouncedSessions / uniqueSessions) * 100) : 0}%`);
    options.setText("stats-pages", String(new Set(periodVisits.map((visit) => pageLabel(visit.page_path, visit.page_key))).size));
    const geoCoverage = periodVisitCount ? Math.round((knownCountryVisits.length / periodVisitCount) * 100) : 0;
    options.setText("stats-geo-coverage", `${geoCoverage}%`);
    options.setText(
      "stats-geo-note",
      unknownCountryCount
        ? `${unknownCountryCount} просмотров без географии. Большая часть — исторические данные, перенесённые до серверного определения стран.`
        : "Страна определена для всех просмотров выбранного периода."
    );

    renderRows("stats-top-pages", topPages, "Посещений пока нет.");
    renderRows("stats-countries", countryRows, "Страны пока не определены.");
    renderRows("stats-referrers", referrerRows, "Источников пока нет.");
    renderRows("stats-devices", deviceRows, "Данных по устройствам пока нет.");
    renderRows("stats-languages", languageRows, "Данных по языкам пока нет.");
    renderRows("stats-entry-pages", entryRows, "Входных страниц пока нет.");
    renderRows("stats-recent", recent, "Посещений пока нет.");
    renderDailyChart("stats-daily", allVisits, chartDays);
    options.setText("editor-status", "Статистика обновлена.");
  };

  const bindEvents = (): void => {
    requiredElement<HTMLButtonElement>(options.$, "refresh-stats-button").addEventListener("click", load);
    const periodSelect = options.$("stats-period-select") as HTMLSelectElement | null;
    periodSelect?.addEventListener("change", load);
  };

  return {
    bindEvents,
    load
  };
}
