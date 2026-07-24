import { getLLMText, source } from "@/lib/source";

export const revalidate = false;

export async function GET() {
  const scan = source.getPages().map(getLLMText);
  const scanned = await Promise.all(scan);

  const header = `# Ryu Documentation (Full Text)

This file contains every page of the Ryu documentation in plain Markdown.
Each page is delimited by "--- END OF PAGE ---" and starts with a Source/Title/Description header.

Total pages: ${scanned.length}
Base URL: ${process.env.NEXT_PUBLIC_SITE_URL || "https://docs.ryuhq.com"}

## Other LLM-friendly endpoints

- GET /llms.txt                    — Index of all pages (title + URL)
- GET /llms-full.txt               — This file (all pages concatenated)
- GET /llms.mdx/docs/{slug}        — Single page as processed Markdown
- GET /docs/{path}.mdx             — Processed Markdown (rewrite to /llms.mdx/)
- GET /llms-sections/{section}     — All pages in a section (start-here, gateway, core, etc.)
- GET /schemas/plugin.json         — JSON Schema for manifest.json manifests

Valid sections: start-here, integrate, desktop, cli, mobile, hardware, gateway, core, security, develop, benchmark, skills, mcp, cookbook, academy

---

`;

  return new Response(header + scanned.join("\n\n--- END OF PAGE ---\n\n"), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
