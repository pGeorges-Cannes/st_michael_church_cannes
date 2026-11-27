import { escapeHtml, formatPublicDate, richTextToHtml, safePublicUrl } from "./shared";
import type { LanguageCode, ParishNews, ParishNewsPhoto } from "./types";

type SupabaseClient = {
  from: (table: string) => any;
};

type PhotosByNews = Record<string, ParishNewsPhoto[]>;

const readMoreLabels: Record<LanguageCode, string> = {
  ru: "Читать полностью",
  fr: "Lire la suite",
  en: "Read more",
};

const notFoundLabels: Record<LanguageCode, string> = {
  ru: "Новость не найдена или еще не опубликована.",
  fr: "L'actualité est introuvable ou n'est pas encore publiée.",
  en: "The news item was not found or is not published yet.",
};

const SITE_ORIGIN = "https://saint-michel-cannes.fr";

function upsertMeta(selector: string, attribute: "name" | "property", key: string, content: string): void {
  let node = document.head.querySelector<HTMLMetaElement>(selector);
  if (!node) {
    node = document.createElement("meta");
    node.setAttribute(attribute, key);
    document.head.appendChild(node);
  }
  node.content = content;
}

function upsertLink(selector: string, rel: string, href: string, hreflang?: string): void {
  let node = document.head.querySelector<HTMLLinkElement>(selector);
  if (!node) {
    node = document.createElement("link");
    node.rel = rel;
    if (hreflang) node.hreflang = hreflang;
    document.head.appendChild(node);
  }
  node.href = href;
}

function plainText(value: string | null | undefined): string {
  const container = document.createElement("div");
  container.innerHTML = richTextToHtml(value || "");
  return (container.textContent || "").replace(/\s+/g, " ").trim();
}

function updateNewsSeo(item: ParishNews, photos: ParishNewsPhoto[], language: LanguageCode): void {
  const suffix = language === "ru" ? "" : `-${language}`;
  const canonical = `${SITE_ORIGIN}/news-detail${suffix}.html?id=${encodeURIComponent(item.id)}`;
  const description = plainText(item.excerpt || item.body).slice(0, 200) || item.title;
  const image = (photos || []).map((photo) => safePublicUrl(photo.file_url)).find(Boolean) || `${SITE_ORIGIN}/assets/seo-church.jpg`;
  const title = `${item.title} | ${language === "ru" ? "Храм Архангела Михаила в Каннах" : language === "fr" ? "Église Saint-Michel-Archange à Cannes" : "St Michael the Archangel Church in Cannes"}`;

  document.title = title;
  upsertMeta('meta[name="description"]', "name", "description", description);
  upsertMeta('meta[property="og:type"]', "property", "og:type", "article");
  upsertMeta('meta[property="og:title"]', "property", "og:title", item.title);
  upsertMeta('meta[property="og:description"]', "property", "og:description", description);
  upsertMeta('meta[property="og:url"]', "property", "og:url", canonical);
  upsertMeta('meta[property="og:image"]', "property", "og:image", image);
  upsertMeta('meta[name="twitter:title"]', "name", "twitter:title", item.title);
  upsertMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
  upsertMeta('meta[name="twitter:image"]', "name", "twitter:image", image);
  upsertLink('link[rel="canonical"]', "canonical", canonical);

  (["ru", "fr", "en"] as LanguageCode[]).forEach((code) => {
    const codeSuffix = code === "ru" ? "" : `-${code}`;
    upsertLink(`link[rel="alternate"][hreflang="${code}"]`, "alternate", `${SITE_ORIGIN}/news-detail${codeSuffix}.html?id=${encodeURIComponent(item.id)}`, code);
  });
  upsertLink('link[rel="alternate"][hreflang="x-default"]', "alternate", `${SITE_ORIGIN}/news-detail.html?id=${encodeURIComponent(item.id)}`, "x-default");

  let schema = document.head.querySelector<HTMLScriptElement>("#news-structured-data");
  if (!schema) {
    schema = document.createElement("script");
    schema.id = "news-structured-data";
    schema.type = "application/ld+json";
    document.head.appendChild(schema);
  }
  schema.textContent = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: item.title,
    description,
    datePublished: item.event_date,
    inLanguage: language,
    mainEntityOfPage: canonical,
    image: [image],
    author: { "@id": `${SITE_ORIGIN}/#church` },
    publisher: { "@id": `${SITE_ORIGIN}/#church` }
  });
}

function groupPhotos(photos: ParishNewsPhoto[] = []): PhotosByNews {
  return photos.reduce<PhotosByNews>((groups, photo) => {
    const key = photo.news_id;
    if (!groups[key]) groups[key] = [];
    groups[key].push(photo);
    return groups;
  }, {});
}

function newsDetailUrl(id: string, language: LanguageCode): string {
  const suffix = language === "ru" ? "" : `-${language}`;
  return `news-detail${suffix}.html?id=${encodeURIComponent(id)}`;
}

function syncDetailLanguageLinks(id: string): void {
  document.querySelectorAll<HTMLAnchorElement>(".church-lang-switch a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (!href.startsWith("news-detail")) return;
    link.href = `${href.split("?")[0]}?id=${encodeURIComponent(id)}`;
  });
}

function renderNewsCard(item: ParishNews, photos: ParishNewsPhoto[], language: LanguageCode): string {
  const safePhotos = (photos || [])
    .map((photo) => ({ ...photo, safe_url: safePublicUrl(photo.file_url) }))
    .filter((photo) => photo.safe_url);
  const firstPhoto = safePhotos[0];

  return `
      <article class="news-card">
        ${firstPhoto ? `<img class="news-card-image" src="${escapeHtml(firstPhoto.safe_url)}" alt="${escapeHtml(firstPhoto.description || item.title)}" loading="lazy">` : ""}
        <time>${escapeHtml(formatPublicDate(item.event_date, language))}</time>
        <h3>${escapeHtml(item.title)}</h3>
        <div class="news-card-excerpt">${item.excerpt ? richTextToHtml(item.excerpt) : ""}</div>
        <a class="text-link news-read-more" href="${escapeHtml(newsDetailUrl(item.id, language))}">${escapeHtml(readMoreLabels[language])}</a>
        ${safePhotos.length > 1 ? `<div class="news-photo-strip">${safePhotos.map((photo) => `<img src="${escapeHtml(photo.safe_url)}" alt="${escapeHtml(photo.description || item.title)}" loading="lazy">`).join("")}</div>` : ""}
      </article>
    `;
}

function renderNewsDetail(item: ParishNews, photos: ParishNewsPhoto[], language: LanguageCode): void {
  const titleNode = document.querySelector<HTMLElement>("[data-news-detail-title]");
  const dateNode = document.querySelector<HTMLElement>("[data-news-detail-date]");
  const bodyNode = document.querySelector<HTMLElement>("[data-news-detail-body]");
  const photosNode = document.querySelector<HTMLElement>("[data-news-detail-photos]");

  if (titleNode) titleNode.textContent = item.title;
  if (dateNode) dateNode.textContent = formatPublicDate(item.event_date, language);
  if (bodyNode) bodyNode.innerHTML = richTextToHtml(item.body || item.excerpt || "");

  if (photosNode) {
    const safePhotos = (photos || [])
      .map((photo) => ({ ...photo, safe_url: safePublicUrl(photo.file_url) }))
      .filter((photo) => photo.safe_url);

    photosNode.innerHTML = safePhotos
      .map(
        (photo) => `
          <figure class="photo-card">
            <img src="${escapeHtml(photo.safe_url)}" alt="${escapeHtml(photo.description || item.title)}" loading="lazy">
            ${photo.description ? `<figcaption>${escapeHtml(photo.description)}</figcaption>` : ""}
          </figure>
        `,
      )
      .join("");
  }
}

async function resolveTranslatedNewsDetail(client: SupabaseClient, id: string, language: LanguageCode): Promise<ParishNews | null> {
  const { data: direct } = await client
    .from("parish_news")
    .select("*")
    .eq("id", id)
    .eq("language", language)
    .eq("status", "published")
    .maybeSingle();

  if (direct) return direct as ParishNews;

  const { data: source } = await client
    .from("parish_news")
    .select("id, translation_group_id")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();

  const groupId = source?.translation_group_id || source?.id;
  if (!groupId) return null;

  const { data: translated } = await client
    .from("parish_news")
    .select("*")
    .eq("translation_group_id", groupId)
    .eq("language", language)
    .eq("status", "published")
    .maybeSingle();

  return (translated || null) as ParishNews | null;
}

async function loadNewsDetail(client: SupabaseClient, language: LanguageCode): Promise<void> {
  const detailNode = document.querySelector<HTMLElement>("[data-news-detail]");
  if (!detailNode) return;

  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    detailNode.innerHTML = `<p class="empty-public-message">${escapeHtml(notFoundLabels[language])}</p>`;
    return;
  }
  syncDetailLanguageLinks(id);

  const item = await resolveTranslatedNewsDetail(client, id, language);
  if (!item) {
    detailNode.innerHTML = `<p class="empty-public-message">${escapeHtml(notFoundLabels[language])}</p>`;
    return;
  }

  const { data: photos } = await client
    .from("parish_news_photos")
    .select("*")
    .eq("news_id", item.id)
    .order("sort_order", { ascending: true });

  const newsPhotos = (photos || []) as ParishNewsPhoto[];
  updateNewsSeo(item, newsPhotos, language);
  renderNewsDetail(item, newsPhotos, language);
}

export async function loadNews(client: SupabaseClient, language: LanguageCode): Promise<void> {
  const hasHomeNews = document.querySelector("[data-home-news]");
  const hasNewsList = document.querySelector("[data-news-list]");
  const hasNewsDetail = document.querySelector("[data-news-detail]");

  if (hasNewsDetail) {
    await loadNewsDetail(client, language);
  }

  if (!hasHomeNews && !hasNewsList) return;

  const [{ data: news }, { data: photos }] = await Promise.all([
    client
      .from("parish_news")
      .select("*")
      .eq("language", language)
      .eq("status", "published")
      .order("event_date", { ascending: false })
      .order("sort_order", { ascending: true }),
    client.from("parish_news_photos").select("*").order("sort_order", { ascending: true })
  ]);

  const items = (news || []) as ParishNews[];
  const photosByNews = groupPhotos((photos || []) as ParishNewsPhoto[]);

  if (hasHomeNews) {
    hasHomeNews.innerHTML = items
      .slice(0, 3)
      .map((item) => renderNewsCard(item, photosByNews[item.id] || [], language))
      .join("");
  }

  if (hasNewsList) {
    if (!items.length) {
      hasNewsList.innerHTML = `<p class="empty-public-message">${language === "fr" ? "Les nouvelles seront publiées prochainement." : language === "en" ? "News will be published soon." : "Новости будут опубликованы в ближайшее время."}</p>`;
    } else {
      hasNewsList.innerHTML = items.map((item) => renderNewsCard(item, photosByNews[item.id] || [], language)).join("");
    }
  }
}
