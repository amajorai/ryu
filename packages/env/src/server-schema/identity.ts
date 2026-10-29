import { z } from "zod";

/** Core control-plane bootstrap, auth, origins, email, OAuth providers and storage. */
export const identityServerEnv = {
	DATABASE_URL: z.string().min(1),
	BETTER_AUTH_SECRET: z.string().min(32),
	BETTER_AUTH_URL: z.url(),
	// Optional Better Auth secret rollover list. The first versioned entry is
	// current; older entries remain valid for verification until retired.
	BETTER_AUTH_SECRETS: z.string().optional(),
	// Better Auth rate-limit/session IP resolution. Keep the header list and
	// trusted proxy ranges explicit at the deployment boundary.
	BETTER_AUTH_IP_ADDRESS_HEADERS: z.string().optional(),
	BETTER_AUTH_TRUSTED_PROXIES: z.string().optional(),
	POLAR_ACCESS_TOKEN: z.string().min(1),
	POLAR_SUCCESS_URL: z.url(),
	// Where buyers pay. "first-party" (default) hands clients Ryu's own
	// checkout pages on FRONTEND_URL, which drive Polar's client checkout API and
	// Stripe Checkout's custom UI mode; "hosted" falls back to the provider-hosted
	// Polar checkout/portal and Stripe Checkout pages.
	BILLING_CHECKOUT_SURFACE: z
		.enum(["first-party", "hosted"])
		.default("first-party"),
	CORS_ORIGIN: z.string().optional(),
	// Trusted Core-to-Gateway relay shared by the API provisioning path,
	// hosted Gateway, and managed Core nodes. Never inject it into agents.
	GATEWAY_CORE_RELAY_KEY: z.string().optional(),
	// Proof-only key used by managed Core requests alongside their org relay;
	// unlike the Core relay it is never accepted as Authorization.
	GATEWAY_CORE_PROOF_KEY: z.string().optional(),
	// Master the per-organization Core proof keys derive from. When set,
	// new managed nodes receive their organization's key instead of the
	// shared GATEWAY_CORE_PROOF_KEY. The hosted Gateway needs the same value.
	GATEWAY_CORE_PROOF_MASTER_KEY: z.string().optional(),
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
	// Mandatory two-factor enrollment (authenticator app or passkey) for every
	// signed-in account. On when NODE_ENV=production and off otherwise;
	// "false"/"0" switches it off and "true"/"1" switches it on, accepted
	// case-insensitively, matching `mfaEnrollmentEnforced` in @ryu/auth.
	AUTH_REQUIRE_MFA: z
		.string()
		.trim()
		.toLowerCase()
		.pipe(z.enum(["true", "false", "1", "0"]))
		.optional(),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	// Server-managed field encryption for the control-plane MongoDB
	// (docs/encryption-at-rest.md slice 4). Base64 of exactly 32 random
	// bytes. Optional in the schema so Docker builds can set
	// SKIP_ENV_VALIDATION; **required at runtime when NODE_ENV=production**
	// (enforced after createEnv — see the throw below). Legacy plaintext rows
	// still read once a key is configured so lazy migration can upgrade them
	// on the next write. The local-only RYU_DB_ALLOW_PLAINTEXT_SECRETS escape is
	// read by @ryu/db from the raw process env, never declared here.
	RYU_DB_MASTER_KEY: z
		.string()
		.refine((value) => Buffer.from(value, "base64").length === 32, {
			message: "RYU_DB_MASTER_KEY must decode to exactly 32 bytes",
		})
		.optional(),
	// PKCS#8 DER Ed25519 private key, base64 encoded. Signs canonical fleet
	// desired-state snapshots; fleet enrollment/reconciliation is unavailable
	// when it is absent rather than falling back to an ephemeral trust root.
	RYU_FLEET_SIGNING_PRIVATE_KEY: z.string().optional(),
	// Email (useSend — self-hosted Resend-compatible API)
	USESEND_API_KEY: z.string().optional(),
	// Base URL of the useSend instance (e.g. https://send.amajor.ai). When
	// unset, @ryu/email falls back to the documented default host.
	USESEND_URL: z.url().optional(),
	// Contact book used for marketing-email subscribe/unsubscribe.
	USESEND_CONTACT_BOOK_ID: z.string().optional(),
	FROM_EMAIL: z.string().email().optional(),
	// Opt-in switch for lifecycle email (monthly usage recaps, idle-agent
	// spend notices, re-engagement check-ins). Off unless exactly "true" so a
	// self-hosted or staging control plane never emails its users unasked.
	LIFECYCLE_EMAILS_ENABLED: z.enum(["true", "false"]).optional(),
	// The Ryu Router own-supply OpenRouter catalog refresh (boot and every 6 h,
	// packages/api/src/lib/own-supply-catalog.ts). On unless exactly "false",
	// for a deploy or hermetic test stack with no egress to openrouter.ai.
	RYU_OWN_SUPPLY_CATALOG_REFRESH_ENABLED: z.enum(["true", "false"]).optional(),
	FRONTEND_URL: z.string().optional(),
	// Browser build of the desktop app. Better Auth must trust this origin for
	// the anonymous guest session and any future browser-only auth methods.
	WEBAPP_URL: z.url().optional(),
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
	// Stable secret for deriving gift claim links. Set a dedicated value in
	// production so auth-secret rotation does not invalidate existing gifts.
	RYU_GIFT_CLAIM_SECRET: z.string().min(32).optional(),
	// Organization integrations GitHub App (separate from the read-only
	// Marketplace App's RYU_GITHUB_APP_*). All optional: the integrations
	// page reports "not configured" without them. Read by
	// packages/api/src/lib/org-github-app.ts.
	RYU_GITHUB_ORG_APP_ID: z.string().optional(),
	RYU_GITHUB_ORG_APP_SLUG: z.string().optional(),
	RYU_GITHUB_ORG_APP_PRIVATE_KEY: z.string().optional(),
	RYU_GITHUB_ORG_APP_CLIENT_ID: z.string().optional(),
	RYU_GITHUB_ORG_APP_CLIENT_SECRET: z.string().optional(),
	RYU_GITHUB_ORG_APP_WEBHOOK_SECRET: z.string().optional(),
	RYU_GITHUB_ORG_APP_STATE_SECRET: z.string().min(32).optional(),
	// Marketing web origin for server-side billing/email redirects when the
	// API router builds a profile URL. Optional: defaults to
	// http://localhost:3001 (same as FRONTEND_URL in dev).
	NEXT_PUBLIC_FRONTEND_URL: z.string().optional(),
	// Waitlist admins (comma-separated emails). Empty = waitlist bypassed on
	// self-hosted installs (see packages/auth/lib/waitlist.ts). Cloud sets
	// this to a non-empty allowlist so the queue is fail-closed.
	ADMIN_EMAILS: z.string().optional(),
	// Explicit waitlist switch, and the authority when set: "true"/"1"/"on"
	// forces the queue ON even with no admins configured, "false"/"0"/"off"
	// forces it OFF even with admins. Unset (the default) keeps the historical
	// behaviour of deriving the state from whether ADMIN_EMAILS is empty.
	WAITLIST_ENABLED: z.string().optional(),
	// Vendor-signed RS256 Enterprise license for self-hosted deployments.
	// The public key is verification-only and should be distributed with the
	// deployment; neither value is exposed to browser bundles.
	RYU_ENTERPRISE_LICENSE: z.string().optional(),
	RYU_ENTERPRISE_LICENSE_PUBLIC_KEY: z.string().optional(),
	// Optional exact domain allowlist for Teams admission. When set, every
	// Teams member must use one of these verified domains; when unset, the
	// built-in public-mailbox denylist (Gmail, Outlook, etc.) is used.
	RYU_TEAMS_ALLOWED_EMAIL_DOMAINS: z.string().optional(),
	// Chrome extension origin trusted by Better Auth CORS (device-auth flow).
	// Optional: defaults to chrome-extension://<NEXT_PUBLIC_EXTENSION_ID>.
	EXTENSION_ORIGIN: z.string().optional(),
	// Auth providers
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
	// Optional user-level account-linking providers. These providers are
	// available from Settings → Connections when both credentials are set;
	// the public social sign-in flow remains Google-only.
	DISCORD_CLIENT_ID: z.string().optional(),
	DISCORD_CLIENT_SECRET: z.string().optional(),
	// Community-server invites. A bot in the Ryu Discord with Create Invite on
	// this channel mints one single-use invite per signed-in user (see
	// packages/api/src/routers/discord-invite.ts). Unset = invites disabled.
	DISCORD_COMMUNITY_BOT_TOKEN: z.string().optional(),
	DISCORD_COMMUNITY_INVITE_CHANNEL_ID: z.string().optional(),
	GITHUB_CLIENT_ID: z.string().optional(),
	GITHUB_CLIENT_SECRET: z.string().optional(),
	// Optional Telegram Login (OIDC) shortcut for the hosted bot. The client id
	// and secret come from the official Ryu bot's BotFather Login Widget setup;
	// the username is public and lets the success page link back to the bot.
	TELEGRAM_LOGIN_CLIENT_ID: z.string().optional(),
	TELEGRAM_LOGIN_CLIENT_SECRET: z.string().optional(),
	TELEGRAM_LOGIN_BOT_USERNAME: z.string().optional(),
	// Bot token of the bot that opens the Telegram Mini App. Only used to verify
	// the HMAC on Mini App initData; never sent to a client.
	TELEGRAM_MINI_APP_BOT_TOKEN: z.string().optional(),
	TURNSTILE_SECRET_KEY: z.string().optional(),
	// Storage (S3-compatible)
	STORAGE_ACCESS_KEY_ID: z.string().optional(),
	STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
	STORAGE_REGION: z.string().optional(),
	STORAGE_ENDPOINT: z.string().optional(),
	STORAGE_BUCKET_NAME: z.string().optional(),
	STORAGE_FORCE_PATH_STYLE: z.string().optional(),
};
