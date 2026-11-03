import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import { docsHref } from "../data/resources.tsx";
import {
	ENGLISH_LIMIT_VALUES,
	formatCount,
	PUBLISHED_PRICING,
	type PublishedMailAllowance,
} from "../data/standalone-pricing.ts";
import type { ProductArchetypeId, ProductProfile } from "./profile-types.ts";
import {
	PRICING_SOURCE,
	servicesCliRow,
	servicesSdkRow,
	profileMessage as tl,
} from "./profiles-agent-api-a-data.ts";
import { MESSAGING_PROFILE } from "./profiles-agent-api-b-messaging.ts";
import { SITES_PROFILE } from "./profiles-agent-api-b-sites.ts";

/**
 * Product profiles for Mail, Messaging and Sites
 * (unit agent-api-b). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each page tells a different story. Mail is an inbox per agent: its
 * allowances, and a hosted quickstart from key to first send. Messaging
 * (./profiles-agent-api-b-messaging.ts) is a ceiling on every send, with no
 * dollar amount anywhere. Sites (./profiles-agent-api-b-sites.ts) deploys only
 * the reviewed version, and a secret in it blocks the deploy. The SDK and CLI
 * rows say they are not on npm yet; no profile shows an install command.
 */
export const ARCHETYPE = "agent-api" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"mail",
	"messaging",
	"sites",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const MAIL = `${DOCS}/standalone/mail.mdx`;
const MAIL_API = `${DOCS}/standalone/mail-api.mdx`;
const MAIL_DELIVERY = `${DOCS}/standalone/mail-delivery.mdx`;
const MAIL_WEBHOOKS = `${DOCS}/standalone/mail-api-webhooks.mdx`;
const MAIL_SDK = `${DOCS}/standalone/sdk/mail.mdx`;
const MAIL_MCP = `${DOCS}/standalone/sdk/mcp-hosted-mail.mdx`;

const SEND_KEY = '-H "Idempotency-Key: welcome-42" \\';

const MAIL_SEND = [
	'curl -sS -X POST "https://api.ryuhq.com/api/mail/inboxes/<inbox-id>/send" \\',
	'  -H "x-api-key: $RYU_API_KEY" \\',
	'  -H "X-Ryu-Organization: $RYU_ORGANIZATION_ID" \\',
	`  ${SEND_KEY}`,
	'  -H "Content-Type: application/json" \\',
	`  -d '{"to":["person@example.com"],"subject":"Welcome","text":"Hello from Ryu Mail."}'`,
].join("\n");

const SELF_HOST_RUN = "cargo run --manifest-path backend/Cargo.toml";

const MAIL_SELF_HOST = [
	"git clone --depth 1 https://github.com/amajorai/ryu-mail.git",
	"cd ryu-mail",
	'export RYU_MAIL_API_TOKEN="$(openssl rand -hex 32)"',
	"RYU_MAIL_MODE=standalone \\",
	"RYU_MAIL_HOSTNAME=127.0.0.1 \\",
	"RYU_MAIL_PORT=7996 \\",
	"RYU_DIR=/var/lib/ryu-mail \\",
	SELF_HOST_RUN,
].join("\n");

const LIST_INBOXES_LINE =
	'curl -sS "https://api.ryuhq.com/api/mail/inboxes" \\';

const LIST_INBOXES = [
	LIST_INBOXES_LINE,
	'  -H "x-api-key: $RYU_API_KEY" \\',
	'  -H "Accept: application/json"',
].join("\n");

const KEY_EXPORT = 'export RYU_API_KEY="<ryu_ key with Mail: Read & send>"';

const { mail } = PUBLISHED_PRICING;

/** "5,000 emails and 10 GiB a month", one message so it reads whole in any language. */
function monthlyMailAllowance(allowance: PublishedMailAllowance): string {
	return tl("{emails} emails and {storageGib} GiB a month", {
		emails: formatCount(allowance.monthlyEmails),
		storageGib: formatCount(allowance.storageGib),
	});
}

export const MAIL_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Hosted mailbox",
			value:
				"One permanent mailbox per organization; each agent claims its own address",
			source: {
				path: MAIL,
				quote:
					"A hosted organization has one permanent mailbox, which an admin with `mail.manage` claims once.",
			},
		},
		{
			label: "Inbound mail",
			value: "Accepted only with the inbox's HMAC signature",
			source: {
				path: MAIL_DELIVERY,
				quote:
					"The inbound webhook accepts raw mail only after the per-inbox HMAC check.",
			},
		},
		{
			label: "Secrets at rest",
			value:
				"Inbound and webhook signing secrets sealed with ChaCha20-Poly1305",
			source: {
				path: MAIL,
				quote:
					"Mail always stores inbox inbound secrets, webhook signing secrets, and webhook custom header values encrypted, with ChaCha20-Poly1305 under a key derived for Mail.",
			},
		},
		{
			label: "A send",
			value: "A hand-off to your transport; it cannot be recalled",
			source: {
				path: MAIL_DELIVERY,
				quote:
					"It does not prove that the recipient received the message, and the send cannot be recalled.",
			},
		},
		{
			label: "Self-hosted",
			value: "One tenant per process, built from source",
			source: {
				path: MAIL,
				quote: "The standalone process serves one tenant per service instance.",
			},
		},
	],
	code: [
		{
			id: "mail-send",
			label: "Send from an inbox",
			language: "bash",
			code: MAIL_SEND,
			source: { path: MAIL_SDK, quote: SEND_KEY },
		},
		{
			id: "mail-self-host",
			label: "Run it yourself",
			language: "bash",
			code: MAIL_SELF_HOST,
			source: { path: MAIL, quote: SELF_HOST_RUN },
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Mail API",
			summary:
				"Inboxes, messages, threads, drafts and scheduled sends, allow and block lists, and custom domains, on one contract for hosted and self-hosted Mail.",
			href: docsHref("/docs/standalone/mail-api"),
			source: {
				path: MAIL_SDK,
				quote: "Hosted and self-hosted Mail share one `/api/mail/*` contract;",
			},
		},
		{
			kind: "Webhook",
			name: "Signed inbound mail and event webhooks",
			summary:
				"Your mail provider posts signed raw mail in; signed event webhooks go out, to public HTTPS endpoints only.",
			href: docsHref("/docs/standalone/mail-api-webhooks"),
			source: {
				path: MAIL_WEBHOOKS,
				quote: "Destinations must be public HTTPS endpoints.",
			},
		},
		{
			kind: "MCP",
			name: "Hosted Mail MCP tools",
			summary:
				"Six Mail tools on Ryu's hosted MCP endpoint, signed in with OAuth, with no node and nothing to install.",
			href: docsHref("/docs/standalone/sdk/mcp-hosted-mail"),
			source: {
				path: MAIL_MCP,
				quote:
					"Ryu's hosted MCP endpoint also serves six Mail tools itself, without a node and without installing anything.",
			},
		},
		servicesSdkRow("Mail", "/docs/standalone/sdk/mail"),
		servicesCliRow("ryu-services mail", "/docs/standalone/sdk/mail-cli-mcp"),
	],
	openapi: {
		href: "/openapi/mail.json",
		baseUrl: "https://api.ryuhq.com",
		source: {
			path: "apps/web/public/openapi/mail.json",
			quote:
				"Hosted Mail. Node gateway key (x-gateway-key), Ryu API key with mail scopes (x-api-key) or console session.",
		},
	},
	limits: {
		title: "Allowances and send limits",
		rows: [
			{
				label: "Free baseline",
				value: ENGLISH_LIMIT_VALUES.freeMailBaseline,
				note: "Granted once per person. Emails are counted per recipient, and the baseline never overflows into credits.",
				source: PRICING_SOURCE,
			},
			{
				label: "Pro",
				value: monthlyMailAllowance(mail.pro),
				source: PRICING_SOURCE,
			},
			{
				label: "Max",
				value: monthlyMailAllowance(mail.max),
				source: PRICING_SOURCE,
			},
			{
				label: "Teams and Business",
				value: monthlyMailAllowance(mail.organization),
				source: PRICING_SOURCE,
			},
			{
				label: "Beyond a paid allowance",
				value: ENGLISH_LIMIT_VALUES.mailOverageRecipients,
				note: "Drawn from a positive credit balance; without one, the send is refused.",
				source: PRICING_SOURCE,
			},
			{
				label: "One send",
				value: "50 recipients",
				note: "Up to 8 MiB of decoded attachments, in a JSON body of up to 12 MiB.",
				source: {
					path: MAIL_API,
					quote:
						"The API accepts at most 50 recipients and 8 MiB of decoded attachments (`413` above that), in a JSON body of up to 12 MiB.",
				},
			},
		],
	},
	quickstart: [
		{
			title: "Create a key with Mail access",
			description:
				"In the Ryu console, create a fine-grained token and set its Mail access to Read & send.",
			source: {
				path: MAIL_SDK,
				quote:
					"Set its **Mail** access to **Read & send** for the quickstart above.",
			},
		},
		{
			title: "Export it",
			description:
				"A personal key also needs RYU_ORGANIZATION_ID; an organization key acts in its own organization.",
			command: KEY_EXPORT,
			source: { path: MAIL_SDK, quote: KEY_EXPORT },
		},
		{
			title: "Find your inbox",
			description:
				"List the inboxes the key can reach. Add X-Ryu-Organization when it is a personal key.",
			command: LIST_INBOXES,
			source: { path: MAIL_SDK, quote: LIST_INBOXES_LINE },
		},
		{
			title: "Send with an idempotency key",
			description:
				"Send as shown above. Retrying with the same key is safe; reusing it for a different request returns 409.",
			source: {
				path: MAIL_API,
				quote:
					"Use `Idempotency-Key` for a safe retry of a send; reusing a key with a different request returns `409`.",
			},
		},
	],
	related: [
		{
			label: "Ryu for sales teams",
			href: "/guides/ryu-for-sales",
			kind: "guide",
		},
		{
			label: "Agent Inboxes: mailbox, addresses, and approval",
			href: "/docs/extend/develop/agent-inboxes",
			kind: "docs",
		},
		{
			label: "Agent Inboxes limits and billing",
			href: "/docs/billing/agent-inboxes",
			kind: "docs",
		},
	],
	docs: [
		{
			label: "Ryu Mail",
			path: "/docs/standalone/mail",
			description: "Deployment shapes, sealing, and hosted limits.",
		},
		{
			label: "Mail SDK quickstart",
			path: "/docs/standalone/sdk/mail",
			description: "A first send with curl, the SDK, the CLI, and MCP.",
		},
		{
			label: "Mail API",
			path: "/docs/standalone/mail-api",
			description: "Every route, send rule, and error code.",
		},
	],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	mail: MAIL_PROFILE,
	messaging: MESSAGING_PROFILE,
	sites: SITES_PROFILE,
};
