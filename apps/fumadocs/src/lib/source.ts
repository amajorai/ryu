import { docs } from "collections/server";
import { type InferPageType, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";

import { openapi } from "@/lib/openapi";
import { siteConfig } from "@/lib/metadata";

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  // `openapi.loaderPlugin()` decorates generated API pages in the page tree with
  // their HTTP method badge (GET/POST/...).
  plugins: [lucideIconsPlugin(), openapi.loaderPlugin()],
});

export function getPageImage(page: InferPageType<typeof source>) {
  const segments = [...page.slugs, "image.webp"];

  return {
    segments,
    url: `/og/docs/${segments.join("/")}`,
  };
}

export async function getLLMText(page: InferPageType<typeof source>) {
  const processed = await page.data.getText("processed");

  // For API reference pages, extract the HTTP method and path from frontmatter
  // to produce a structured header that agents can parse.
  const openapi = (page.data as Record<string, unknown>)._openapi as
    | { method?: string; structuredData?: { contents?: Array<{ content?: string }> } }
    | undefined;

  const methodLine = openapi?.method
    ? `Method: ${openapi.method.toUpperCase()}`
    : "";
  const descriptionFromSpec =
    openapi?.structuredData?.contents?.[0]?.content ?? "";

  const header = [
    `Source: ${siteConfig.url}${page.url}`,
    `Title: ${page.data.title}`,
    methodLine ? `${methodLine}` : "",
    `Description: ${page.data.description || descriptionFromSpec}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `${header}\n\n${processed}`;
}
