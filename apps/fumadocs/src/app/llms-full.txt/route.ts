import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  const scan = source.getPages().map(getLLMText);
  const scanned = await Promise.all(scan);

  const header = `# Ryu Documentation (Full Text)

This file contains every page of the Ryu documentation in plain Markdown.
Each page is delimited by a horizontal rule (---) and starts with a Source/Title/Description header.

Total pages: ${scanned.length}
Base URL: ${process.env.NEXT_PUBLIC_SITE_URL || "https://docs.ryuhq.com"}

---

`;

  return new Response(header + scanned.join("\n\n---\n\n"));
}
