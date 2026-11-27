import type { LanguageCode } from "./types";

type SupabaseQuery = {
  insert: (payload: Record<string, unknown>) => Promise<{ error?: { message?: string } } | unknown>;
};

type SupabaseClient = {
  from: (table: string) => SupabaseQuery;
};

interface VisitorIdentity {
  visitorId: string;
  sessionId: string;
  isNewVisitor: boolean;
  firstSeenAt: string;
  landingPage: string;
}

interface StoredSession {
  id: string;
  landingPage: string;
  lastSeenAt: number;
}

const VISITOR_KEY = "st_michael_visitor_id";
const LEGACY_VISITOR_KEY = "st_michael_visit_session";
const SESSION_KEY = "st_michael_active_session";
const FIRST_SEEN_KEY = "st_michael_first_seen_at";
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_BACKEND_URL = "https://st-michael-church-cannes.onrender.com";

function safeStorageGet(key: string): string {
  try {
    return window.localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Statistics must also work in browsers that block localStorage.
  }
}

function newId(): string {
  return window.crypto?.randomUUID ? window.crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

function readSession(): StoredSession | null {
  try {
    const value = JSON.parse(safeStorageGet(SESSION_KEY));
    if (!value?.id || !value?.lastSeenAt) return null;
    return value as StoredSession;
  } catch {
    return null;
  }
}

function visitorIdentity(): VisitorIdentity {
  const now = Date.now();
  let visitorId = safeStorageGet(VISITOR_KEY) || safeStorageGet(LEGACY_VISITOR_KEY);
  let firstSeenAt = safeStorageGet(FIRST_SEEN_KEY);
  const isNewVisitor = !visitorId || !firstSeenAt;

  if (!visitorId) visitorId = newId();
  if (!firstSeenAt) firstSeenAt = new Date(now).toISOString();
  safeStorageSet(VISITOR_KEY, visitorId);
  safeStorageSet(FIRST_SEEN_KEY, firstSeenAt);

  let session = readSession();
  if (!session || now - session.lastSeenAt > SESSION_TIMEOUT_MS) {
    session = { id: newId(), landingPage: window.location.pathname, lastSeenAt: now };
  } else {
    session.lastSeenAt = now;
  }
  safeStorageSet(SESSION_KEY, JSON.stringify(session));

  return {
    visitorId,
    sessionId: session.id,
    isNewVisitor,
    firstSeenAt,
    landingPage: session.landingPage
  };
}

function detectDevice(): string {
  const userAgent = navigator.userAgent || "";
  if (/ipad|tablet|kindle|silk/i.test(userAgent)) return "tablet";
  if (/mobi|android|iphone|ipod/i.test(userAgent)) return "mobile";
  return "desktop";
}

function detectBrowser(): string {
  const userAgent = navigator.userAgent || "";
  if (/edg\//i.test(userAgent)) return "Edge";
  if (/opr\//i.test(userAgent)) return "Opera";
  if (/firefox\//i.test(userAgent)) return "Firefox";
  if (/safari\//i.test(userAgent) && !/chrome\//i.test(userAgent)) return "Safari";
  if (/chrome\//i.test(userAgent)) return "Chrome";
  return "Other";
}

function detectOs(): string {
  const userAgent = navigator.userAgent || "";
  if (/windows/i.test(userAgent)) return "Windows";
  if (/iphone|ipad|ipod/i.test(userAgent)) return "iOS";
  if (/android/i.test(userAgent)) return "Android";
  if (/mac os|macintosh/i.test(userAgent)) return "macOS";
  if (/linux/i.test(userAgent)) return "Linux";
  return "Other";
}

function isBot(): boolean {
  return /bot|crawler|spider|headless|lighthouse|preview|facebookexternalhit|whatsapp/i.test(navigator.userAgent || "");
}

async function insertDirectly(client: SupabaseClient, payload: Record<string, unknown>): Promise<void> {
  let countryCode = "";
  try {
    const response = await fetch("https://api.country.is/", { cache: "no-store" });
    const data = response.ok ? await response.json() : {};
    countryCode = /^[A-Z]{2}$/.test(data.country || "") ? data.country : "";
  } catch {
    // Country remains unknown when the independent geo service is unavailable.
  }
  let countryName = "";
  if (countryCode) {
    try {
      countryName = new Intl.DisplayNames(["ru"], { type: "region" }).of(countryCode) || countryCode;
    } catch {
      countryName = countryCode;
    }
  }
  const result = await client.from("page_visits").insert({
    ...payload,
    country_code: countryCode || null,
    country_name: countryName || null
  }) as { error?: { message?: string } } | undefined;
  if (result?.error) throw new Error(result.error.message || "Visit insert failed");
}

async function insertThroughBackend(payload: Record<string, unknown>): Promise<boolean> {
  const backendUrl = (window.ST_MICHAEL_BACKEND_URL || DEFAULT_BACKEND_URL).replace(/\/$/, "");
  try {
    const response = await fetch(`${backendUrl}/api/visits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function trackVisit(client: SupabaseClient, pageKey: string, language: LanguageCode): Promise<void> {
  const file = window.location.pathname.split("/").pop() || "index.html";
  if (file === "admin.html" || isBot()) return;

  const identity = visitorIdentity();
  const payload = {
    page_key: pageKey,
    page_path: window.location.pathname,
    language,
    session_id: identity.sessionId,
    visitor_id: identity.visitorId,
    is_new_session: identity.isNewVisitor,
    first_seen_at: identity.firstSeenAt,
    landing_page: identity.landingPage,
    referrer: document.referrer ? document.referrer.slice(0, 500) : "",
    user_agent: navigator.userAgent ? navigator.userAgent.slice(0, 500) : "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    visitor_language: (navigator.language || "").slice(0, 40),
    device_type: detectDevice(),
    browser_name: detectBrowser(),
    os_name: detectOs(),
    screen_width: window.screen?.width || null,
    screen_height: window.screen?.height || null
  };

  try {
    if (!await insertThroughBackend(payload)) await insertDirectly(client, payload);
  } catch {
    // Statistics must never block public page rendering.
  }
}
