import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  // Self-contained server bundle for a lean Docker runtime (apps/fumadocs/Dockerfile).
  output: "standalone",
  // Type/lint are gated in CI/editor, not the deploy build.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  serverExternalPackages: ["@takumi-rs/image-response"],
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/docs/:path*.mdx",
        destination: "/llms.mdx/docs/:path*",
      },
    ];
  },
  async redirects() {
    return [
      // "/" renders the docs landing page (src/app/(home)); only "/docs"
      // (the bare docs root) forwards into the first realm.
      {
        source: "/docs",
        destination: "/docs/start-here",
        permanent: false,
      },
      // The recipes gallery became its own "Cookbook" root. Keep the old
      // /docs/using-ryu/recipes URLs (and every recipe under it) alive.
      {
        source: "/docs/using-ryu/recipes",
        destination: "/docs/cookbook",
        permanent: true,
      },
      {
        source: "/docs/using-ryu/recipes/:path*",
        destination: "/docs/cookbook/:path*",
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
