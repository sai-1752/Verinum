import { useEffect } from "react";

const ORIGIN = () => (import.meta.env.VITE_PUBLIC_URL as string | undefined) ?? window.location.origin;

function setMeta(sel: string, attr: "name" | "property", key: string, content: string) {
  let el = document.head.querySelector<HTMLMetaElement>(sel);
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.content = content;
}

/** Per-page title, description, canonical URL, social tags and optional structured data. */
export function useSeo(o: { title: string; description: string; path: string; jsonLd?: object; noindex?: boolean }) {
  useEffect(() => {
    document.title = o.title;
    setMeta('meta[name="description"]', "name", "description", o.description);
    setMeta('meta[property="og:title"]', "property", "og:title", o.title);
    setMeta('meta[property="og:description"]', "property", "og:description", o.description);
    setMeta('meta[property="og:url"]', "property", "og:url", ORIGIN() + o.path);
    setMeta('meta[name="robots"]', "name", "robots", o.noindex ? "noindex, nofollow" : "index, follow");
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) { link = document.createElement("link"); link.rel = "canonical"; document.head.appendChild(link); }
    link.href = ORIGIN() + o.path;
    let ld: HTMLScriptElement | null = null;
    if (o.jsonLd) { ld = document.createElement("script"); ld.type = "application/ld+json"; ld.dataset.page = "1"; ld.text = JSON.stringify(o.jsonLd); document.head.appendChild(ld); }
    return () => { ld?.remove(); };
  }, [o.title, o.description, o.path, o.noindex, o.jsonLd]);
}
