import { createAPIPage } from "fumadocs-openapi/ui";

import { openapi } from "@/lib/openapi";

/**
 * Server component rendered for every `<APIPage />` in the generated OpenAPI MDX.
 *
 * Kept out of `@/lib/openapi` so the heavy UI/highlighter import is only pulled
 * into the docs page render path, never into `source.ts`.
 */
export const APIPage = createAPIPage(openapi);
