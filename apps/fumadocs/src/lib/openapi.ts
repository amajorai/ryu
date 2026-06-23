import { createOpenAPI } from "fumadocs-openapi/server";

/**
 * Render-time OpenAPI server.
 *
 * Holds every spec the docs reference. The generated MDX pages call
 * `<APIPage document="<schema-id>" ... />`, where the schema id is the exact
 * input path string below; `APIPage` resolves the operation against this server,
 * so the inputs here must stay in sync with the ones in `scripts/generate-docs.ts`.
 *
 * - `gateway-openapi.yaml` is hand-authored (the OpenAI-compatible gateway surface).
 * - `core-openapi.json` is generated from Core's Axum handlers by `utoipa`
 *   (`apps/core` → `bun run generate:openapi`), then consumed here.
 *
 * This module stays lightweight (no UI imports) so it is safe to pull into
 * `source.ts` for the page-tree `loaderPlugin`. The `<APIPage />` render
 * component lives in `@/components/api-page` (server-only, page render path).
 */
export const openapi = createOpenAPI({
  input: ["./specs/gateway-openapi.yaml", "./specs/core-openapi.json"],
});
