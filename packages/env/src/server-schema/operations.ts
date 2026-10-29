import { z } from "zod";

/** Branding, DNS, observability, catalog upstreams, managed cloud, Gateway and managed agents. */
export const operationsServerEnv = {
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
	// own machines, no consent gate). The destination is the code constant
	// RYU_AXIOM_ENDPOINT (https://api.axiom.co) in packages/api ryu-analytics.ts.
	// With the token or dataset unset the emitter is a complete no-op (it never
	// POSTs, never throws) so a deployment without observability keys runs
	// unchanged. Ryu-owned names are authoritative for new deployments; the
	// generic AXIOM_* names below remain a server-only compatibility fallback.
	RYU_AXIOM_TOKEN: z.string().optional(),
	RYU_AXIOM_DATASET: z.string().optional(),
	// Private shared secret used only by the hosted Gateway to reach the typed
	// Ryu analytics relay. It is never sent to managed customer nodes.
	RYU_ANALYTICS_INGEST_SECRET: z.string().optional(),
	// Bearer token for the OTLP endpoint (Axiom API token).
	AXIOM_TOKEN: z.string().optional(),
	// Server-side crash reporting (Sentry). Server-tier posture like the OTLP
	// wide events above: Ryu's own machines, NO per-user consent gate. Gated on
	// the DSN alone; unset ⇒ a complete no-op (see apps/server/src/instrument.ts).
	// RYU_CRASH_REPORTS_ENABLED is not read here: that name is the consent
	// override for the Core, Gateway and client tiers. SENTRY_DSN is the
	// Sentry-standard name; RYU_SENTRY_DSN is the Ryu-namespaced mirror shared
	// with the Rust tiers.
	SENTRY_DSN: z.string().optional(),
	RYU_SENTRY_DSN: z.string().optional(),
	// Sentry release tag for server-side crash reports (instrument.ts). Also
	// read by the web app when NEXT_PUBLIC_APP_VERSION is unset. Optional.
	RYU_RELEASE: z.string().optional(),
	// Axiom dataset the wide events land in (sent as the X-Axiom-Dataset
	// header). Required by Axiom; ignored by a generic OTLP Collector.
	AXIOM_DATASET: z.string().optional(),
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
	// Master key of the Gateway that signs marketplace manifests
	// (`gateway-admin.key` / GATEWAY_MASTER_KEY). `POST /v1/manifests/sign`
	// always requires it (a keyless Gateway cannot sign), from any peer; it
	// is sent only to an https:// or loopback RYU_GATEWAY_URL. Falls back to
	// GATEWAY_ADMIN_KEY, then GATEWAY_MASTER_KEY, for a co-located Gateway.
	RYU_GATEWAY_MASTER_KEY: z.string().optional(),
	// Legacy bootstrap only: dedicated company-owned Telegram/Discord bots are
	// now imported through the platform-admin inventory route and stored sealed
	// in ManagedBotAllocation. Keep this only while migrating older deploys;
	// once imported, remove it so MongoDB is the source of truth.
	RYU_MANAGED_BOT_POOL: z.string().optional(),
	// Shared secret the hosted gateway fleet presents (as `x-ryu-internal-
	// secret`) to read UNSEALED provider keys from the vault. Mirrors
	// RYU_CREDITS_INTERNAL_SECRET. Optional: when unset, the unsealed vault
	// read is unreachable (fail-closed), never a session fallback.
	RYU_VAULT_INTERNAL_SECRET: z.string().optional(),
	// Ryu's own platform org: the only org whose node-control credentials a
	// platform admin may grant `gateway.violations.report`, which lets the
	// hosted fleet report violation events for any tenant org. Optional:
	// when unset no credential can be granted it (fail-closed).
	RYU_PLATFORM_ORG_ID: z.string().optional(),
	// Bootstrap and emergency layer of the feature-flag system: a JSON object of
	// flag key -> boolean, applied over the catalog defaults and under the admin
	// console's database overrides (packages/api/src/lib/feature-flags.ts).
	// Changing it needs a redeploy, so normal rollouts use the admin console.
	// Deliberately a plain string: the reader logs and ignores a malformed value
	// instead of failing boot, so a typo cannot take the API down mid-incident.
	RYU_FEATURE_FLAGS: z.string().optional(),
};
