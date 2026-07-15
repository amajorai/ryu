import type { Metadata } from "next";

export const siteConfig = {
  name: "Ryu Docs",
  description:
    "Documentation for Ryu — end-to-end infrastructure for AI agents",
  url: process.env.NEXT_PUBLIC_SITE_URL || "https://docs.ryuhq.com",
};

export function generateMetadata(): Metadata {
  return {
    title: siteConfig.name,
    description: siteConfig.description,
    metadataBase: new URL(siteConfig.url),
    appleWebApp: {
      title: "Ryu",
    },
    openGraph: {
      title: siteConfig.name,
      description: siteConfig.description,
      url: siteConfig.url,
      siteName: siteConfig.name,
      locale: "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: siteConfig.name,
      description: siteConfig.description,
    },
  };
}
