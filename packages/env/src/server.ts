import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
	server: {
		DATABASE_URL: z.string().min(1),
		BETTER_AUTH_SECRET: z.string().min(32),
		BETTER_AUTH_URL: z.url(),
		POLAR_ACCESS_TOKEN: z.string().min(1),
		POLAR_SUCCESS_URL: z.url(),
		CORS_ORIGIN: z.string().optional(),
		// Cross-subdomain auth cookie domain. The frontend (ryuhq.com) and the
		// auth API (api.ryuhq.com) are different subdomains, so a host-only
		// session cookie set by the API is never sent on a navigation to the
		// apex — the SSR portal gate then reads "no session" and bounces to
		// /login, which (client-side) has the session and bounces back, an
		// infinite loop. Setting this to the shared parent (e.g. "ryuhq.com")
		// makes the cookie cross-subdomain so SSR can read it. Leave UNSET in
		// local dev (localhost has no shared parent domain) to keep host-only
		// cookies.
		AUTH_COOKIE_DOMAIN: z.string().optional(),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
		// Server-managed field encryption for the control-plane MongoDB
		// (docs/encryption-at-rest.md slice 4). Base64 of exactly 32 random
		// bytes. Optional in the schema so Docker builds can set
		// SKIP_ENV_VALIDATION; **required at runtime when NODE_ENV=production**
		// (enforced after createEnv — see the throw below). Legacy plaintext rows
		// still read once a key is configured so lazy migration can upgrade them
		// on the next write.
		RYU_DB_MASTER_KEY: z.string().optional(),
		// Local development escape hatch for running without
		// RYU_DB_MASTER_KEY. Never set this in production.
		RYU_DB_ALLOW_PLAINTEXT_SECRETS: z.string().optional(),
		// Email (useSend — self-hosted Resend-compatible API)
		USESEND_API_KEY: z.string().optional(),
		// Base URL of the useSend instance (e.g. https://send.amajor.ai). When
		// unset, @ryu/email falls back to the documented default host.
		USESEND_URL: z.url().optional(),
		// Contact book used for marketing-email subscribe/unsubscribe.
		USESEND_CONTACT_BOOK_ID: z.string().optional(),
		FROM_EMAIL: z.string().email().optional(),
		FRONTEND_URL: z.string().optional(),
		// Server-side control-plane base URL (non-public). Used when code must
		// reach the Hono server without going through the browser bundle's
		// NEXT_PUBLIC_SERVER_URL (e.g. SSR cert pages, Composio relay fallback).
		// Optional: falls back to NEXT_PUBLIC_SERVER_URL / BETTER_AUTH_URL in
		// each call site.
		SERVER_URL: z.string().optional(),
		// Public URL Composio relay webhooks advertise to Composio (must be
		// reachable from the internet in production). Optional: falls back to
		// BETTER_AUTH_URL, then SERVER_URL, then http://localhost:3000.
		RYU_PUBLIC_URL: z.string().optional(),
		// Marketing web origin for server-side billing/email redirects when the
		// API router builds a profile URL. Optional: defaults to
		// http://localhost:3001 (same as FRONTEND_URL in dev).
		NEXT_PUBLIC_FRONTEND_URL: z.string().optional(),
		// Waitlist admins (comma-separated emails). Empty = waitlist bypassed on
		// self-hosted installs (see packages/auth/lib/waitlist.ts). Cloud sets
		// this to a non-empty allowlist so the queue is fail-closed.
		ADMIN_EMAILS: z.string().optional(),
		// Rough waitlist throughput estimate (invites per week). Optional:
		// packages/auth defaults to 50 when unset or invalid.
		WAITLIST_INVITES_PER_WEEK: z.string().optional(),
		// Chrome extension origin trusted by Better Auth CORS (device-auth flow).
		// Optional: defaults to chrome-extension://<NEXT_PUBLIC_EXTENSION_ID>.
		EXTENSION_ORIGIN: z.string().optional(),
		// Auth providers
		GOOGLE_CLIENT_ID: z.string().optional(),
		GOOGLE_CLIENT_SECRET: z.string().optional(),
		TURNSTILE_SECRET_KEY: z.string().optional(),
		// Storage (S3-compatible)
		STORAGE_ACCESS_KEY_ID: z.string().optional(),
		STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
		STORAGE_REGION: z.string().optional(),
		STORAGE_ENDPOINT: z.string().optional(),
		STORAGE_BUCKET_NAME: z.string().optional(),
		STORAGE_FORCE_PATH_STYLE: z.string().optional(),
		// Notion
		NOTION_API_KEY: z.string().optional(),
		// Notion API 2025-09-03 split databases into databases + data sources;
		// these hold DATA SOURCE ids. The *_DATABASE_ID names are the pre-split
		// spelling, still accepted so existing deployments keep working.
		NOTION_BLOG_DATA_SOURCE_ID: z.string().optional(),
		NOTION_PAGES_DATA_SOURCE_ID: z.string().optional(),
		NOTION_HELP_DATA_SOURCE_ID: z.string().optional(),
		NOTION_CHANGELOG_DATA_SOURCE_ID: z.string().optional(),
		NOTION_BLOG_DATABASE_ID: z.string().optional(),
		NOTION_PAGES_DATABASE_ID: z.string().optional(),
		NOTION_HELP_DATABASE_ID: z.string().optional(),
		NOTION_CHANGELOG_DATABASE_ID: z.string().optional(),
		// Polar
		POLAR_ORGANIZATION_ID: z.string().optional(),
		POLAR_SERVER: z.enum(["sandbox", "production"]).default("sandbox"),
		// Plan-catalog product/price ids (epic #496). All optional: each falls back
		// to the documented default in `@ryu/auth/lib/plans`. See
		// `docs/polar-products.md` for which products/prices/benefits to create.
		POLAR_PRODUCT_DESKTOP_LICENSE: z.string().optional(),
		POLAR_PRODUCT_PRO_MONTHLY: z.string().optional(),
		POLAR_PRODUCT_PRO_YEARLY: z.string().optional(),
		POLAR_PRODUCT_MAX_MONTHLY: z.string().optional(),
		POLAR_PRODUCT_MAX_YEARLY: z.string().optional(),
		POLAR_PRODUCT_TEAMS_MONTHLY: z.string().optional(),
		POLAR_PRICE_TEAMS_MONTHLY_SEAT: z.string().optional(),
		POLAR_PRODUCT_TEAMS_YEARLY: z.string().optional(),
		POLAR_PRICE_TEAMS_YEARLY_SEAT: z.string().optional(),
		// Single recurring product cloud-instance checkouts attach an ad-hoc
		// fixed price to (per-checkout amount = round(live Hetzner cost × markup);
		// the product's own base price is only a catalog placeholder). The Max
		// plan already includes a free BASE (cx23) node, so BASE has no charge.
		// Optional: absent ⇒ ad-hoc cloud-instance checkout is refused.
		POLAR_PRODUCT_CLOUD_INSTANCE: z.string().optional(),
		// Pay-what-you-want product credit top-ups check out against (Unit B2).
		POLAR_PRODUCT_CREDITS: z.string().optional(),
		// FIXED-price product auto top-up charges off-session (its price must equal
		// the configured pack `amountCents`). Optional: absent ⇒ auto-topup cannot
		// charge and is effectively off. Requires the Polar org to have the
		// `off_session_charges_enabled` feature flag.
		POLAR_PRODUCT_AUTOTOPUP: z.string().optional(),
		// Polar webhook signing secret (Standard Webhooks). When unset, the
		// first-party credits top-up webhook degrades cleanly (503), never crashes.
		POLAR_WEBHOOK_SECRET: z.string().optional(),
		// Stripe (marketplace monetization #485). All optional: absent keys must
		// degrade cleanly (credits top-up/webhook disabled), never crash on import.
		STRIPE_SECRET_KEY: z.string().optional(),
		STRIPE_WEBHOOK_SECRET: z.string().optional(),
		// Connect vars are consumed by the paid-items unit (#486); declared here so
		// the env schema is complete and nothing crashes when they are present.
		STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
		STRIPE_CONNECT_WEBHOOK_SECRET: z.string().optional(),
		// Marketplace direct-charge migration flag (#490,
		// docs/stripe-connect-direct-charges-migration.md). DEFAULT OFF: absent /
		// anything but "true" keeps the destination-charge path (charge on the
		// PLATFORM, seller SG-only). Set "true" to charge ON the seller's connected
		// account (direct charge → 46 seller countries), keeping the platform fee.
		// BEFORE flipping true you MUST (a) subscribe checkout.session.completed /
		// payment_intent.succeeded / charge.refunded / charge.dispute.created on the
		// Connect webhook endpoint (direct-charge success events fire there with
		// `event.account` set — a platform endpoint never sees them, so licenses
		// silently stop being written), and (b) re-onboard existing sellers for the
		// `card_payments` capability + let `account.updated` backfill chargesEnabled.
		MARKETPLACE_DIRECT_CHARGE: z.string().optional(),
		// Secret shared with the gateway so the internal debit endpoint can be
		// called service-to-service (the gateway debits arbitrary orgs). Optional:
		// when unset, debit falls back to an authenticated user session.
		RYU_CREDITS_INTERNAL_SECRET: z.string().optional(),
		// Where Stripe redirects after a credit top-up checkout.
		STRIPE_SUCCESS_URL: z.string().optional(),
		STRIPE_CANCEL_URL: z.string().optional(),
		// First-party Ryu affiliate program (replaces Dub). The default
		// subscription-commission rule is assembled from these in code; ALL
		// optional and parsed/defaulted there (type=percent, value=2000 bps=20%,
		// recurring=true, duration_months=12). See `@ryu/api` affiliate config.
		AFFILIATE_SUBSCRIPTION_TYPE: z.string().optional(),
		AFFILIATE_SUBSCRIPTION_VALUE: z.string().optional(),
		AFFILIATE_SUBSCRIPTION_RECURRING: z.string().optional(),
		AFFILIATE_SUBSCRIPTION_DURATION_MONTHS: z.string().optional(),
		// Agent Inboxes / Ryu Mail (AgentMail-equivalent over AWS SES). ALL
		// optional: with these unset the mail endpoints degrade to 503
		// "mail not configured" — they never crash boot or the web build.
		// The domain SES sends/receives for; inbox addresses are <local>@<domain>.
		RYU_MAIL_DOMAIN: z.string().optional(),
		// AWS region the SES (send) + inbound receipt rule live in. Falls back to
		// STORAGE_REGION, then us-east-1, when unset.
		AWS_SES_REGION: z.string().optional(),
		// SES/S3 credentials. Fall back to the existing STORAGE_* creds (and then
		// the ambient AWS credential chain) when unset.
		AWS_ACCESS_KEY_ID: z.string().optional(),
		AWS_SECRET_ACCESS_KEY: z.string().optional(),
		// S3 bucket the SES inbound receipt rule writes raw MIME into (and we read
		// back to parse). When unset, inbound delivered inline by SNS still works;
		// S3-backed delivery + attachments require this.
		RYU_MAIL_S3_BUCKET: z.string().optional(),
		// Optional shared secret appended to the inbound webhook URL as `?token=`
		// for defence-in-depth on top of SNS signature verification.
		RYU_MAIL_INBOUND_SECRET: z.string().optional(),
		// Public marketing URL the "Sent from Ryu" agent-email footer links to (the
		// growth-loop CTA). Optional: falls back to the DEFAULT_BRAND_URL in
		// @ryu/mail. This is the brand site, NOT the app (FRONTEND_URL).
		RYU_BRAND_URL: z.string().optional(),
		// Cloudflare DNS provisioning for per-tenant mail subdomains
		// (`<slug>.<RYU_MAIL_DOMAIN>` — deliverability isolation). Both optional:
		// absent ⇒ subdomain provisioning is off and inboxes stay on the base
		// domain (@ryu/mail's isCloudflareConfigured() gates it). The token needs
		// DNS-edit scope on the zone that owns RYU_MAIL_DOMAIN.
		CLOUDFLARE_API_TOKEN: z.string().optional(),
		CLOUDFLARE_ZONE_ID: z.string().optional(),
		// Control-plane server logs -> Axiom via OTLP wide events (#541, P2 of
		// docs/observability-analytics-support-access.md). Server-side only (Ryu's
		// own machines, no consent gate). ALL optional and swappable: the OTLP
		// destination is config, never hardcoded. With the endpoint+token unset the
		// emitter is a complete no-op (it never POSTs, never throws) so a deployment
		// without observability keys runs unchanged. Standard OTLP/HTTP endpoint
		// (e.g. https://api.axiom.co for Axiom, or any OTel Collector / Grafana
		// host). The emitter appends the standard `/v1/logs` path itself.
		OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
		// Bearer token for the OTLP endpoint (Axiom API token).
		AXIOM_TOKEN: z.string().optional(),
		// Server-side crash reporting (Sentry). Server-tier posture like the OTLP
		// wide events above: Ryu's own machines, NO per-user consent gate. Gated on
		// env only — a DSN plus RYU_CRASH_REPORTS_ENABLED (default ON, opt-out).
		// Both optional and swappable; unset ⇒ a complete no-op (see
		// apps/server/src/instrument.ts). SENTRY_DSN is the Sentry-standard name;
		// RYU_SENTRY_DSN is the Ryu-namespaced mirror shared with the Rust tiers.
		SENTRY_DSN: z.string().optional(),
		RYU_SENTRY_DSN: z.string().optional(),
		RYU_CRASH_REPORTS_ENABLED: z.string().optional(),
		// Sentry release tag for server-side crash reports (instrument.ts). Also
		// read by the web app when NEXT_PUBLIC_APP_VERSION is unset. Optional.
		RYU_RELEASE: z.string().optional(),
		// Axiom dataset the wide events land in (sent as the X-Axiom-Dataset
		// header). Required by Axiom; ignored by a generic OTLP Collector.
		AXIOM_DATASET: z.string().optional(),
		// Composio relay ingress (packages/api composio-relay router). Optional:
		// when unset the ingress rejects all webhooks (fail-closed).
		COMPOSIO_WEBHOOK_SECRET: z.string().optional(),
		// Marketplace staff-picks + affiliate admin allowlist (comma-separated
		// emails). Optional: unset denies everyone (see marketplace.ts).
		RYU_MARKETPLACE_ADMIN_EMAILS: z.string().optional(),
		// Catalog / marketplace federation upstreams (packages/api federation.ts).
		// All optional — each falls back to the live public default.
		RYU_HF_API_URL: z.string().optional(),
		RYU_HF_HOST: z.string().optional(),
		SKILLS_SH_API_URL: z.string().optional(),
		RYU_MCP_REGISTRY_URL: z.string().optional(),
		// --- Ryu Managed Cloud, WS6 (docs/managed-cloud-spec.md) ---------------
		// MASTER SAFETY FLAG for live Hetzner infrastructure. Default OFF: with
		// this unset/"false" the servers router records DB state and LOGS what it
		// WOULD do, but fires NO Hetzner API call. Only "true" (or "1") arms the
		// live CREATE path. Destroy stays gated even when this is on (see
		// RYU_HETZNER_DESTROY_CONFIRM).
		RYU_HETZNER_LIVE: z.string().optional(),
		// Explicit opt-in to the SIMULATED (fake-active) provisioning path. Unset ⇒
		// simulate is allowed ONLY in non-production (NODE_ENV !== "production");
		// "true"/"1" force-enables it (e.g. a prod-like staging that must never touch
		// Hetzner); "false"/"0" force-disables it (fail closed even in dev). It never
		// enables LIVE infra — that is RYU_HETZNER_LIVE + HCLOUD_TOKEN. In real
		// production leave this unset so an unarmed deploy fails closed instead of
		// fabricating a node that does not exist.
		RYU_CLOUD_SIMULATE: z.string().optional(),
		// ADDITIONAL destroy gate. Live server DESTROY is the scariest automated
		// action (a webhook replay could delete a node with user data), so it is
		// NEVER wired to fire on its own — the live-delete seam is hardcoded off in
		// code. This flag exists as the documented, human-set confirmation input
		// for that seam; on its own it does nothing. Default OFF.
		RYU_HETZNER_DESTROY_CONFIRM: z.string().optional(),
		// Hetzner Cloud API token, read from the CONTROL-PLANE HOST env only (never
		// the vault — the vault serves provider keys to the fleet, this is Ryu's
		// own infra credential). Optional: absent ⇒ live provisioning cannot run
		// even if RYU_HETZNER_LIVE is set (the router logs and no-ops).
		HCLOUD_TOKEN: z.string().optional(),
		// Default Hetzner location for new servers when a request omits `region`.
		HCLOUD_DEFAULT_REGION: z.string().optional(),
		// Markup applied to the live Hetzner compute cost to price the paid
		// 2X/3X cloud add-ons (monthlyAddUsd = liveMonthlyUsd * multiplier).
		// Optional: `@ryu/api/lib/hetzner-catalog` defaults to 2.5 when unset.
		HETZNER_MARKUP_MULTIPLIER: z.string().optional(),
		// EUR→USD fx rate used to convert Hetzner's EUR prices to USD.
		// Optional: `@ryu/api/lib/hetzner-catalog` defaults to 1.08 when unset.
		HETZNER_EUR_USD: z.string().optional(),
		// The hosted gateway fleet base URL a managed node routes chat egress to
		// (threaded into a node's cloud-init as RYU_GATEWAY_URL). Optional.
		RYU_GATEWAY_URL: z.string().optional(),
		// Shared secret the hosted gateway fleet presents (as `x-ryu-internal-
		// secret`) to read UNSEALED provider keys from the vault. Mirrors
		// RYU_CREDITS_INTERNAL_SECRET. Optional: when unset, the unsealed vault
		// read is unreachable (fail-closed), never a session fallback.
		RYU_VAULT_INTERNAL_SECRET: z.string().optional(),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
	// Skip validation during builds (e.g. the web Docker build imports server
	// modules but has no server secrets). Set SKIP_ENV_VALIDATION=1 at build
	// time only — runtime containers leave it unset so startup still validates.
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});

if (
	!process.env.SKIP_ENV_VALIDATION &&
	env.NODE_ENV === "production" &&
	!env.RYU_DB_MASTER_KEY
) {
	throw new Error(
		"RYU_DB_MASTER_KEY is required in production so sensitive control-plane fields are encrypted at rest."
	);
}
