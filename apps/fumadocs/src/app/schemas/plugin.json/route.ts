import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const revalidate = false;

export async function GET() {
  const schemaPath = join(process.cwd(), "specs", "plugin-schema.json");
  const schema = await readFile(schemaPath, "utf-8");

  return new Response(schema, {
    headers: {
      "Content-Type": "application/schema+json",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
