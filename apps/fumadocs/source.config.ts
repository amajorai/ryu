import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";
import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

// You can customise Zod schemas for frontmatter and `meta.json` here
// see https://fumadocs.dev/docs/mdx/collections
export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    // `level` is the Academy course-difficulty number (100/200/300/...),
    // rendered as a badge on course cards and lesson pages. Optional so the
    // rest of the docs are unaffected.
    schema: pageSchema.extend({
      level: z.number().optional(),
    }),
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    // Convert ```mermaid code blocks into the <Mermaid> client component.
    remarkPlugins: [remarkMdxMermaid],
  },
});
