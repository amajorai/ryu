import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import { docsHref } from "../data/resources.tsx";
import {
	ENGLISH_LIMIT_VALUES,
	formatCount,
	PUBLISHED_PRICING,
} from "../data/standalone-pricing.ts";
import type { ProductArchetypeId, ProductProfile } from "./profile-types.ts";
import { CONNECT_PROFILE } from "./profiles-agent-api-a-connect.ts";
import {
	BOX_PROFILE,
	PRICING_SOURCE,
	servicesCliRow,
	servicesSdkRow,
	profileMessage as tl,
} from "./profiles-agent-api-a-data.ts";
import { NOTIFY_PROFILE } from "./profiles-agent-api-a-notify.ts";

/**
 * Product profiles for Passport, Connect, Box and Notify
 * (unit agent-api-a). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each page tells a different story: Passport is custody (store a login, fetch
 * through it, and a write it was not granted is refused). Connect, Box and
 * Notify each live in a sibling file (-connect, -data, -notify). The SDK and
 * CLI rows say they are not on npm yet; no profile shows an install command.
 */
export const ARCHETYPE = "agent-api" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"passport",
	"connect",
	"box",
	"notify",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const PASSPORT = `${DOCS}/standalone/passport.mdx`;
const PASSPORT_API = `${DOCS}/standalone/passport-api.mdx`;
const PASSPORT_FETCH = `${DOCS}/standalone/passport-fetch-api.mdx`;
const PASSPORT_MCP = `${DOCS}/standalone/passport-mcp-api.mdx`;
const PASSPORT_SDK = `${DOCS}/standalone/sdk/passport.mdx`;
const OPENAPI = "apps/web/public/openapi";

const PASSPORT_STORE = [
	'curl -sS -X POST "$RYU_PASSPORT_URL/v1/connections" \\',
	'  -H "Authorization: Bearer $RYU_PASSPORT_API_KEY" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"profile_id":"work","domain":"api.github.com","source":"manual"}'`,
	"",
	'curl -sS -X POST "$RYU_PASSPORT_URL/v1/connections/<connection-id>/import" \\',
	'  -H "Authorization: Bearer $RYU_PASSPORT_API_KEY" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"state":"<captured state, for example a cookie header>"}'`,
].join("\n");

const PASSPORT_FETCH_CALL = [
	'curl -sS -X POST "$RYU_PASSPORT_URL/v1/connections/<connection-id>/fetch" \\',
	'  -H "Authorization: Bearer $RYU_PASSPORT_RUNTIME_KEY" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"url":"https://api.github.com/user","headers":{"User-Agent":"my-agent"},"credentialHeaders":{"Authorization":"Bearer vault:api.github.com"}}'`,
].join("\n");

const FETCH_REQUEST =
	'curl -sS -X POST "$RYU_PASSPORT_URL/v1/connections/<connection-id>/fetch" -H "Authorization: Bearer $RYU_PASSPORT_RUNTIME_KEY"';

const PASSPORT_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Holds",
			value: "Per-domain cookies, tokens, or session state",
			source: {
				path: PASSPORT,
				quote: "It stores per-domain cookies, tokens, or session state",
			},
		},
		{
			label: "Model access",
			value: "None: credentials are never given to a model",
			source: {
				path: PASSPORT,
				quote: "it does not give credentials to a model.",
			},
		},
		{
			label: "Sealing",
			value: "A separate key per tenant, bound to the tenant and connection",
			source: {
				path: PASSPORT,
				quote:
					"Passport derives a separate encryption key for each tenant from the master key",
			},
		},
		{
			label: "Token guessing",
			value: "Blocked after 30 unknown tokens in a minute",
			source: {
				path: PASSPORT,
				quote:
					"A client address that presents 30 unknown tokens within a minute is blocked for a minute.",
			},
		},
		{
			label: "Distribution",
			value: "Hosted early access; no public build yet",
			source: {
				path: PASSPORT,
				quote:
					"Its source and builds are not published in the public Ryu repository",
			},
		},
	],
	code: [
		{
			id: "passport-store",
			label: "Store a login",
			language: "bash",
			code: PASSPORT_STORE,
			source: {
				path: PASSPORT_SDK,
				quote: `-d '{"profile_id":"work","domain":"api.github.com","source":"manual"}'`,
			},
		},
		{
			id: "passport-fetch",
			label: "Fetch through it",
			language: "bash",
			code: PASSPORT_FETCH_CALL,
			source: {
				path: PASSPORT_SDK,
				quote: '-H "Authorization: Bearer $RYU_PASSPORT_RUNTIME_KEY" \\',
			},
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Passport API",
			summary:
				"Profiles, connections, logins, imports, health sweeps, and the usage report. No response carries a decrypted credential.",
			href: docsHref("/docs/standalone/passport-api"),
			source: {
				path: PASSPORT_API,
				quote:
					"No response contains the `encrypted_state` column or a decrypted credential value.",
			},
		},
		{
			kind: "REST",
			name: "Fetch through a connection",
			summary:
				"Sends one HTTPS request to the stored domain with the sealed credential; the answer is bounded and redacted.",
			href: docsHref("/docs/standalone/passport-fetch-api"),
			source: {
				path: PASSPORT_FETCH,
				quote:
					"Passport keeps the credential sealed and applies destination, method, size, and redaction limits.",
			},
		},
		{
			kind: "MCP",
			name: "MCP OAuth custody",
			summary:
				"Passport runs OAuth for an agent's MCP servers and keeps the provider tokens. No route exports them.",
			href: docsHref("/docs/standalone/passport-mcp-api"),
			source: {
				path: PASSPORT_MCP,
				quote: "No provider-token export route exists.",
			},
		},
		servicesSdkRow("Passport", "/docs/standalone/sdk/passport"),
		servicesCliRow("ryu-services passport", "/docs/standalone/sdk/passport"),
	],
	openapi: {
		href: "/openapi/passport.json",
		source: {
			path: `${OPENAPI}/passport.json`,
			quote: "Your Passport base URL. There is no default hosted URL.",
		},
	},
	limits: {
		title: "Rates and request limits",
		rows: [
			{
				label: "Stored credentials",
				value: ENGLISH_LIMIT_VALUES.passportConnectionMonth,
				note: tl(
					"After {freeConnections} connection-months free each month, per organization.",
					{
						freeConnections: formatCount(
							PUBLISHED_PRICING.passport.freeConnectionMonths
						),
					}
				),
				source: PRICING_SOURCE,
			},
			{
				label: "Upstream fetches",
				value: ENGLISH_LIMIT_VALUES.passportFetches,
				note: tl(
					"After {freeFetches} fetches free each month, per organization.",
					{
						freeFetches: formatCount(
							PUBLISHED_PRICING.passport.freeFetchesPerMonth
						),
					}
				),
				source: PRICING_SOURCE,
			},
			{
				label: "Response body",
				value: "1 MiB",
				note: "Returned text stops at 20,000 characters unless the call raises it.",
				source: {
					path: PASSPORT_FETCH,
					quote:
						"Response bodies are bounded to 1 MiB and returned text to 20,000 characters.",
				},
			},
			{
				label: "JSON request body",
				value: "256 KiB",
				source: {
					path: PASSPORT_FETCH,
					quote: "JSON bodies are capped at 256 KiB.",
				},
			},
			{
				label: "Request headers",
				value: "32 headers, 16 KiB in all",
				source: {
					path: PASSPORT_FETCH,
					quote: "The combined header budget is 32 headers and 16 KiB.",
				},
			},
		],
	},
	guardrail: {
		title: "A runtime grant cannot write unless it was allowed to",
		description:
			"A runtime grant without allowed methods may only GET. Passport refuses any other method with a 403, and it redacts literal echoes of the credential from what comes back.",
		lines: [
			{
				kind: "command",
				text: `${FETCH_REQUEST} -d '{"url":"https://api.github.com/user","headers":{"User-Agent":"my-agent"}}'`,
			},
			{
				kind: "allowed",
				text: "200 · GET through the stored login, credential echoes redacted",
			},
			{
				kind: "command",
				text: `${FETCH_REQUEST} -d '{"url":"https://api.github.com/user","method":"PATCH","headers":{"User-Agent":"my-agent"},"body":{"bio":"hi"}}'`,
			},
			{
				kind: "denied",
				text: "403 forbidden · this grant is not allowed that method",
			},
		],
		source: {
			path: PASSPORT_API,
			quote:
				"The credential is not granted this request, such as an HTTP method (`403`).",
		},
	},
	related: [
		{
			label: "How to connect AI agents to your tools with MCP",
			href: "/blog/how-to-connect-ai-agents-tools-mcp",
			kind: "blog",
		},
		{
			label: "PII redaction and DLP tools for AI agents",
			href: "/blog/best-pii-redaction-dlp-tools-ai-agents",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "Ryu Passport",
			path: "/docs/standalone/passport",
			description: "Sealing, key custody, backoff, and pricing.",
		},
		{
			label: "Passport SDK quickstart",
			path: "/docs/standalone/sdk/passport",
			description: "Store a login and fetch through it.",
		},
		{
			label: "Passport Fetch API",
			path: "/docs/standalone/passport-fetch-api",
			description: "Destination screening, method grants, and redaction.",
		},
	],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	passport: PASSPORT_PROFILE,
	connect: CONNECT_PROFILE,
	box: BOX_PROFILE,
	notify: NOTIFY_PROFILE,
};
