# Docs site (Fumadocs / Next.js, :3002). Bun + Turborepo monorepo.
# Built by Dokploy (buildType=dockerfile, build context = repo root).
FROM oven/bun:1.3.14 AS builder
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# --ignore-scripts skips native postinstalls (napi/electron) the docs never use;
# fumadocs-mdx (normally a postinstall) is run explicitly below in the right order.
# No --frozen-lockfile: this is a single-install -> standalone build (no
# builder/runner version skew), and frozen breaks on registry drift of
# unpinned transitive ranges.
# --linker hoisted: flat node_modules so the native @takumi-rs/image-response
# binding (used by the /og route) is resolvable; bun's default isolated linker
# leaves the platform binding unfindable ("Cannot find native binding").
RUN bun install --ignore-scripts --linker hoisted
# Build order: generate the OpenAPI reference pages -> generate the MDX .source
# index (gitignored, so it must be built here) -> next build (standalone output).
RUN cd apps/fumadocs \
 && bun run generate:docs \
 && bun x fumadocs-mdx \
 && bun x next build \
 && mkdir -p public

# Lean runtime. node:22-slim (glibc, NOT alpine/musl) so the native
# @takumi-rs/image-response OG-image binary loads at runtime.
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3002
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/apps/fumadocs/.next/standalone ./
COPY --from=builder /app/apps/fumadocs/.next/static ./apps/fumadocs/.next/static
COPY --from=builder /app/apps/fumadocs/public ./apps/fumadocs/public
EXPOSE 3002
CMD ["node", "apps/fumadocs/server.js"]
