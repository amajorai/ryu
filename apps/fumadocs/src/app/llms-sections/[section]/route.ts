import { notFound } from "next/navigation";

import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

const VALID_SECTIONS = [
  "start-here",
  "integrate",
  "desktop",
  "cli",
  "mobile",
  "hardware",
  "gateway",
  "core",
  "security",
  "develop",
  "benchmark",
  "skills",
  "mcp",
  "cookbook",
  "academy",
] as const;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ section: string }> },
) {
  const { section } = await params;

  if (!(VALID_SECTIONS as readonly string[]).includes(section)) {
    notFound();
  }

  const pages = source
    .getPages()
    .filter(
      (page) =>
        page.url === `/docs/${section}` ||
        page.url.startsWith(`/docs/${section}/`),
    );

  if (pages.length === 0) {
    notFound();
  }

  const scanned = await Promise.all(pages.map(getLLMText));

  const header = `# Ryu Docs — ${section}

Section: ${section}
Pages: ${scanned.length}
Base URL: ${process.env.NEXT_PUBLIC_SITE_URL || "https://docs.ryuhq.com"}

Each page below starts with a Source/Title header followed by its full Markdown content.

---

`;

  return new Response(header + scanned.join("\n\n--- END OF PAGE ---\n\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export function generateStaticParams() {
  return VALID_SECTIONS.map((section) => ({ section }));
}
