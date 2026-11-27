import { richTextToHtml } from "./shared";
import type { ContentSection, LanguageCode } from "./types";

const SITE_NAMES: Record<LanguageCode, string> = {
  ru: "Храм Архангела Михаила в Каннах",
  fr: "Église Saint-Michel-Archange à Cannes",
  en: "St Michael the Archangel Church in Cannes"
};

function plainText(value: string | null | undefined): string {
  const container = document.createElement("div");
  container.innerHTML = richTextToHtml(value || "");
  return (container.textContent || "").replace(/\s+/g, " ").trim();
}

function setMeta(selector: string, content: string): void {
  const node = document.head.querySelector<HTMLMetaElement>(selector);
  if (node) node.content = content;
}

export function applyPageSeo(hero: ContentSection | undefined, language: LanguageCode, pageKey: string): void {
  if (!hero || pageKey === "news") return;
  const title = plainText(hero.title);
  if (!title) return;

  const description = (plainText(hero.summary) || plainText(hero.body) || document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content || title).slice(0, 200);
  const fullTitle = pageKey === "home" ? title : `${title} | ${SITE_NAMES[language]}`;
  document.title = fullTitle;
  setMeta('meta[name="description"]', description);
  setMeta('meta[property="og:title"]', title);
  setMeta('meta[property="og:description"]', description);
  setMeta('meta[name="twitter:title"]', title);
  setMeta('meta[name="twitter:description"]', description);

  const churchSchema = Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')).find((script) => script.textContent?.includes('"@id":"https://saint-michel-cannes.fr/#church"'));
  if (!churchSchema?.textContent) return;
  try {
    const data = JSON.parse(churchSchema.textContent);
    data.description = description;
    churchSchema.textContent = JSON.stringify(data);
  } catch {
    // Keep the build-time structured data if a browser extension modified it.
  }
}

