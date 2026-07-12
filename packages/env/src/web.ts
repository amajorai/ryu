import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	client: {
		NEXT_PUBLIC_SERVER_URL: z.url(),
		// Public canonical site URL (canonical tags, sitemap, robots, OG, JSON-LD).
		// Defaults to https://ryu.com in metadata when unset; set the real domain in prod.
		NEXT_PUBLIC_SITE_URL: z.url().optional(),
		// Base URL of the local Ryu Core node (:7980), the sidecar manager + chat
		// backend. Web `/chat` proxies /api/chat/stream, /api/agents, and
		// /api/spaces here via next.config rewrites; falls back to localhost when unset.
		NEXT_PUBLIC_CORE_URL: z.url().default("http://localhost:7980"),
		// Base URL of the docs site (separate Fumadocs app). The marketing header
		// links here for "Docs". Defaults to the local docs dev server on :4000;
		// set to https://docs.ryuhq.com in prod.
		NEXT_PUBLIC_DOCS_URL: z.url().default("http://localhost:4000"),
		// Browser build of the desktop app (apps/webapp). The download menu links
		// here for "Web app". Local dev server runs on :5175.
		NEXT_PUBLIC_WEBAPP_URL: z.url().default("http://localhost:5175"),
		NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().optional(),
		NEXT_PUBLIC_STORAGE_ENDPOINT: z.string().optional(),
		NEXT_PUBLIC_STORAGE_BUCKET_NAME: z.string().optional(),
		// PostHog product analytics (P3, closed-UI plane). Optional: when the key is
		// unset the analytics provider is a graceful no-op, so the site runs with no
		// analytics vendor wired (the "nothing hardcoded" posture). The host defaults
		// to PostHog EU Cloud so EU residency (IP capture off by default) is the
		// privacy-leaning default; point it at any PostHog-compatible ingest endpoint.
		NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
		NEXT_PUBLIC_POSTHOG_HOST: z.url().default("https://eu.i.posthog.com"),
		// Sentry crash reporting for the browser bundle (P3 crash tier). Optional:
		// unset ⇒ the client Sentry init is a graceful no-op (no vendor wired). The
		// server/edge runtimes may also read SENTRY_DSN/RYU_SENTRY_DSN directly.
		NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
	},
	runtimeEnv: {
		NEXT_PUBLIC_SERVER_URL: process.env.NEXT_PUBLIC_SERVER_URL,
		NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
		NEXT_PUBLIC_CORE_URL: process.env.NEXT_PUBLIC_CORE_URL,
		NEXT_PUBLIC_DOCS_URL: process.env.NEXT_PUBLIC_DOCS_URL,
		NEXT_PUBLIC_WEBAPP_URL: process.env.NEXT_PUBLIC_WEBAPP_URL,
		NEXT_PUBLIC_TURNSTILE_SITE_KEY: process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY,
		NEXT_PUBLIC_STORAGE_ENDPOINT: process.env.NEXT_PUBLIC_STORAGE_ENDPOINT,
		NEXT_PUBLIC_STORAGE_BUCKET_NAME:
			process.env.NEXT_PUBLIC_STORAGE_BUCKET_NAME,
		NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
		NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
		NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
	},
	emptyStringAsUndefined: true,
	// Skip validation during the Docker build (server modules pulled into the
	// build have no secrets). Set SKIP_ENV_VALIDATION=1 at build time only.
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
