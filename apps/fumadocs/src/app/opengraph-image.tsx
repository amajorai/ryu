import { renderOgCard } from "@/lib/og-card";
import { siteConfig } from "@/lib/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = `${siteConfig.name}: ${siteConfig.description}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PROTOCOL = /^https?:\/\//;

export default function OpenGraphImage() {
  return renderOgCard({
    title: "Documentation for Ryu",
    subtitle: siteConfig.description,
    domain: siteConfig.url.replace(PROTOCOL, ""),
  });
}
