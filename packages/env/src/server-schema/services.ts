import { z } from "zod";
import { mailRealtimeStoreSchema } from "../mail-realtime-store";

/** Mail, Messaging and the hosted standalone services (Box, Notify, Passport, Connect). */
export const servicesServerEnv = {
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
	RYU_MAIL_SNS_TOPIC_ARN: z.string().optional(),
	// "1" once the wildcard MX and the `.<RYU_MAIL_DOMAIN>` receipt-rule
	// recipient are live, so agent aliases on per-org alias hosts
	// (`sales@acme.<RYU_MAIL_DOMAIN>`) receive mail. Unset, alias claims on
	// those hosts answer 503 `alias_hosts_unconfigured`. Infrastructure
	// readiness, not a product flag; the mail router reads it per request.
	RYU_MAIL_ALIAS_HOSTS: z.string().optional(),
	// The Ryu operations inbox that platform role addresses on alias hosts
	// (`postmaster@`, `abuse@`, `admin@`, ...) are delivered to. Unset, that
	// mail is dropped; it never reaches the tenant.
	RYU_MAIL_OPS_INBOX_ADDRESS: z.string().optional(),
	// Where hosted Mail realtime keeps its shared state (tickets, socket
	// leases, event fan-out): `memory` (default, one replica only) or `mongo`
	// (Mongo change streams; needs the replica set). mailRealtimeStoreMode in
	// @ryu/api/lib/mail-realtime reads it through readMailRealtimeStore
	// (./mail-realtime-store.ts, the same schema), so its importers need not
	// validate this whole env; declared here so a typo fails at boot. Flip it
	// with a single replica or a full restart, never during a rolling deploy.
	RYU_MAIL_REALTIME_STORE: mailRealtimeStoreSchema,
	// Ryu Messaging (SMS, MMS, WhatsApp, voice messages, phone numbers over
	// AWS End User Messaging; docs/messaging-service.md). ALL optional: the
	// messaging endpoints answer 503 "messaging not configured" until a
	// configuration set is named. AWS credentials are shared with Mail above
	// (ambient AWS chain when unset). @ryu/messaging reads these lazily.
	// AWS Region for SMS/voice and the WhatsApp WABAs; falls back to
	// AWS_REGION, then us-east-1.
	RYU_MESSAGING_REGION: z.string().optional(),
	// Configuration set every send names; it routes delivery events (and the
	// real price) to the events topic. Required: Messaging is "not
	// configured" without it.
	RYU_MESSAGING_CONFIGURATION_SET: z.string().optional(),
	// The three pinned SNS topics: SMS/MMS/voice events, two-way inbound SMS,
	// and WhatsApp (WABA) events. A message from any other topic is refused
	// before its signing certificate is fetched.
	RYU_MESSAGING_EVENTS_TOPIC_ARN: z.string().optional(),
	RYU_MESSAGING_INBOUND_TOPIC_ARN: z.string().optional(),
	RYU_MESSAGING_WHATSAPP_TOPIC_ARN: z.string().optional(),
	// Shared secret required as `?token=` on the three SNS routes, on top of
	// SNS signature verification.
	RYU_MESSAGING_WEBHOOK_SECRET: z.string().optional(),
	// Private S3 bucket MMS and WhatsApp media are staged in (Ryu writes,
	// AWS reads). MMS sends answer 503 without it.
	RYU_MESSAGING_S3_BUCKET: z.string().optional(),
	// Optional IAM role AWS assumes to publish two-way inbound SMS; unset
	// relies on the inbound topic's policy.
	RYU_MESSAGING_TWO_WAY_ROLE_ARN: z.string().optional(),
	// Hosted Box control-plane bridge. The URL is server-only and the token map
	// is keyed by Better Auth organization id; plaintext tokens never reach the
	// browser or the organization API response.
	RYU_BOX_SERVICE_URL: z.url().optional(),
	RYU_BOX_ORG_TOKENS: z.string().optional(),
	// Signs `rbx1` Box tenant tokens (docs/box-per-session-desktop.md §8.1):
	// an ed25519 private key as PEM PKCS#8, base64 DER PKCS#8, or a raw
	// 32-byte seed (64 hex chars). Its key id is derived from the public key
	// and logged at start; the Box service verifies with the matching entry
	// in its RYU_BOX_TENANT_PUBLIC_KEYS. Unset, orgs bind only through
	// RYU_BOX_ORG_TOKENS and POST /api/box/node-credential answers 503.
	RYU_BOX_TENANT_SIGNING_KEY: z.string().optional(),
	// HMAC secret the Box service signs POST /api/box/fleet-alerts with
	// (`x-ryu-box-signature: sha256=<hex>`). At least 32 printable characters
	// without spaces. Unset, the route answers 404.
	RYU_BOX_ALERT_SECRET: z.string().optional(),
	// Bearer of the Box service's /v1/admin/* routes, used for the hourly
	// core-tenant reconciliation (/v1/admin/usage) and the fleet monitor
	// (/v1/admin/fleet). Unset, both jobs stay off.
	RYU_BOX_ADMIN_KEY: z.string().optional(),
	// Optional JSON mirror of the hosted Gateway's sandbox rates, for the
	// core-tenant reconciliation: {"vcpuNanoUsd":14000,"memGibNanoUsd":4500,
	// "storageGibNanoUsd":30,"freeStorageGib":5,"markupBps":3000,
	// "sizeRatesMicroUsdPerHour":{"small":N,"default":N,"large":N}}. Every
	// field is optional and defaults to the Gateway's compiled default; it
	// must match GATEWAY_CREDITS_* on the Gateway or reconciliation misprices.
	RYU_BOX_CORE_SANDBOX_RATES: z.string().optional(),
	// Hosted service billing: the control plane pulls each Ryu-hosted service's
	// `GET /v1/usage` report with the org's tenant bearer, prices it, and
	// debits the org wallet hourly. Off unless exactly "true", so a deploy opts
	// in; the switch also gates Box create/resume admission (402) and stopping
	// Boxes of exhausted orgs. An org without a token in a service's map is not
	// billed for that service. Box reuses the bridge's URL and token map above.
	RYU_SERVICE_BILLING_ENABLED: z.string().optional(),
	// Comma-separated org ids whose hosted capacity is paid outside the
	// wallet: never settled, never refused with 402, never stopped.
	RYU_SERVICE_BILLING_EXEMPT_ORGS: z.string().optional(),
	// Shared secret hosted services present as `Authorization: Bearer` to
	// poll GET /api/service-billing/status. Unset, the feed answers 404.
	RYU_SERVICE_BILLING_STATUS_SECRET: z.string().optional(),
	// Recommended: per-service status feed secrets, JSON
	// {"box":"...","notify":"...","passport":"...","connect":"..."}. A request
	// for ?service=X then accepts only X's secret; services missing from the
	// map fall back to RYU_SERVICE_BILLING_STATUS_SECRET. Each secret must be
	// printable ASCII without spaces and at least 32 characters.
	RYU_SERVICE_BILLING_STATUS_SECRETS: z.string().optional(),
	RYU_NOTIFY_URL: z.url().optional(),
	RYU_NOTIFY_ORG_TOKENS: z.string().optional(),
	RYU_PASSPORT_URL: z.url().optional(),
	RYU_PASSPORT_ORG_TOKENS: z.string().optional(),
	RYU_CONNECT_URL: z.url().optional(),
	RYU_CONNECT_ORG_TOKENS: z.string().optional(),
	// Secret hosted Connect presents as `Authorization: Bearer` to pull the
	// self-serve key feed (GET /api/connect-keys/feed). Self-serve Connect
	// keys are on only with this set (32+ printable ASCII, distinct from every
	// status feed secret), RYU_CONNECT_URL set, and service billing on.
	RYU_CONNECT_KEY_FEED_SECRET: z.string().optional(),
	// Connect access tokens (Treg parity B7): PKCS#8 DER Ed25519 private key,
	// base64, that signs short-lived Connect-audience tokens. Unset, the
	// fleet key (RYU_FLEET_SIGNING_PRIVATE_KEY) signs them. The public half is
	// served at GET /api/connect-tokens/jwks for hosted Connect.
	RYU_CONNECT_TOKEN_SIGNING_KEY: z.string().optional(),
	// The `aud` Connect expects (its RYU_CONNECT_OAUTH_AUDIENCE). Unset, the
	// origin of RYU_CONNECT_URL.
	RYU_CONNECT_TOKEN_AUDIENCE: z.string().optional(),
	// Bearer the curated tool catalog verifier (tools/tool-catalog-verify.ts,
	// the scheduled drift workflow) presents to read probes and post reports
	// (Treg parity B3). 32+ printable ASCII; unset turns those routes off.
	RYU_TOOL_CATALOG_VERIFIER_SECRET: z.string().optional(),
	// Hybrid search on the anonymous tool catalog browse API (Treg parity C2):
	// the Ryu Gateway origin embeddings and the judge go through, the
	// embedding model, the optional judge model, the operator Gateway key that
	// pays for embedding catalog entries (the caller's x-ryu-gateway-key pays
	// for its query and judge), and the judge calls per caller key per hour
	// (default 30). Unset URL or model leaves hybrid search off.
	RYU_TOOL_CATALOG_DISCOVERY_GATEWAY_URL: z.string().optional(),
	RYU_TOOL_CATALOG_DISCOVERY_EMBEDDING_MODEL: z.string().optional(),
	RYU_TOOL_CATALOG_DISCOVERY_JUDGE_MODEL: z.string().optional(),
	RYU_TOOL_CATALOG_DISCOVERY_INDEX_KEY: z.string().optional(),
	RYU_TOOL_CATALOG_DISCOVERY_JUDGE_PER_HOUR: z.string().optional(),
	// Composio project add-ons Connect settlement prices with: comma list of
	// zdr, baa, ip_allowlist (default none). Must match the Composio project
	// the hosted Connect deployment executes in.
	RYU_CONNECT_COMPOSIO_ADDONS: z.string().optional(),
};
