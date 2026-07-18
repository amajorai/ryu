import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/metadata";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = source.getPages();

  const docEntries: MetadataRoute.Sitemap = pages.map((page) => ({
    url: `${siteConfig.url}${page.url}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [
    {
      url: siteConfig.url,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    ...docEntries,
  ];
}
