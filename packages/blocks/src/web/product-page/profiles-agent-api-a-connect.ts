import { docsHref } from "../data/resources.tsx";
import { ENGLISH_LIMIT_VALUES } from "../data/standalone-pricing.ts";
import type { ProductProfile } from "./profile-types.ts";
import {
	PRICING_SOURCE,
	servicesCliRow,
	servicesSdkRow,
} from "./profiles-agent-api-a-data.ts";

/**
 * Ryu Connect's profile, split out of ./profiles-agent-api-a.ts to keep each
 * file under the size limit. Connect tells an onboarding story: a key, the
 * Skill catalog, one governed Composio action, and hosted MCP. Same grounding
 * rules: every entry names its source file and a verbatim quote (checked by
 * ./profile-grounding.ts); the one price is computed from `PRICING_COPY`.
 */

const DOCS = "apps/fumadocs/content/docs";
const CONNECT = `${DOCS}/standalone/connect.mdx`;
const CONNECT_SDK = `${DOCS}/standalone/sdk/connect.mdx`;
const CONNECT_EVENTS = `${DOCS}/standalone/connect-api-trigger-events.mdx`;
const OPENAPI = "apps/web/public/openapi";

const CONNECT_SKILLS = [
	'curl -sS "$RYU_CONNECT_URL/v1/skills" \\',
	'  -H "Authorization: Bearer $RYU_CONNECT_API_KEY"',
].join("\n");

const CONNECT_EXECUTE = [
	'curl -sS "$RYU_CONNECT_URL/v1/tools/search?q=slack" \\',
	'  -H "Authorization: Bearer $RYU_CONNECT_API_KEY"',
	"",
	'curl -sS -X POST "$RYU_CONNECT_URL/v1/composio/execute" \\',
	'  -H "Authorization: Bearer $RYU_CONNECT_API_KEY" \\',
	'  -H "Content-Type: application/json" \\',
	`  -d '{"operation":"execute","toolId":"SLACK_SEND_MESSAGE","body":{"channel":"#general","text":"Deploy finished"}}'`,
].join("\n");

export const CONNECT_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Lanes",
			value: "MCP, Skills, tools, and Composio behind one bearer",
			source: {
				path: CONNECT,
				quote: "those lanes one tenant-scoped bearer boundary",
			},
		},
		{
			label: "Keys",
			value: "Start with ryu_connect_ and are shown once",
			source: { path: CONNECT, quote: "A key starts with `ryu_connect_`" },
		},
		{
			label: "Served natively",
			value: "GitHub, Linear, Notion, and Slack",
			source: {
				path: CONNECT,
				quote: "Connect serves GitHub, Linear, Notion and Slack natively.",
			},
		},
		{
			label: "Provider credentials",
			value: "Masked out of every answer",
			source: {
				path: CONNECT,
				quote:
					"Connect masks the credentials it sends to a provider out of every answer it returns",
			},
		},
		{
			label: "Distribution",
			value: "Hosted early access; not distributed for self-hosting",
			source: {
				path: CONNECT,
				quote: "Connect is not distributed for self-hosting yet.",
			},
		},
	],
	code: [
		{
			id: "connect-skills",
			label: "Read the Skill catalog",
			language: "bash",
			code: CONNECT_SKILLS,
			source: {
				path: CONNECT_SDK,
				quote: 'curl -sS "$RYU_CONNECT_URL/v1/skills" \\',
			},
		},
		{
			id: "connect-execute",
			label: "Run a Composio action",
			language: "bash",
			code: CONNECT_EXECUTE,
			source: {
				path: CONNECT_SDK,
				quote: `-d '{"operation":"execute","toolId":"SLACK_SEND_MESSAGE","body":{"channel":"#general","text":"Deploy finished"}}'`,
			},
		},
	],
	interfaces: [
		{
			kind: "REST",
			name: "Connect API",
			summary:
				"Skills, tool search and execution, Composio actions, tasks, reviews, and usage.",
			href: docsHref("/docs/standalone/connect-api"),
			source: {
				path: CONNECT_SDK,
				quote: "Search the tools granted to your tenant",
			},
		},
		{
			kind: "MCP",
			name: "Hosted MCP at /mcp",
			summary:
				"Skills as resources and your tenant's granted tools, over stateless Streamable HTTP with the same key.",
			href: docsHref("/docs/standalone/connect-api-mcp"),
			source: {
				path: CONNECT_SDK,
				quote:
					"Connect serves its own MCP server at `/mcp`, with the hosted Skills as resources and your tenant's granted tools.",
			},
		},
		{
			kind: "Webhook",
			name: "Composio trigger events",
			summary:
				"Signed Composio deliveries are verified, queued durably, and handed to an agent or workflow.",
			href: docsHref("/docs/standalone/connect-api-trigger-events"),
			source: {
				path: CONNECT_EVENTS,
				quote:
					"Connect verifies signed Composio deliveries, queues them durably",
			},
		},
		servicesSdkRow("Connect", "/docs/standalone/sdk/connect"),
		servicesCliRow("ryu-services connect", "/docs/standalone/sdk/connect", {
			summary:
				"Prints where Connect's MCP endpoint is, without the key. Connect's own /mcp serves its tools.",
			quote:
				"Running the service name prints where Connect's MCP endpoint is, without the key:",
			path: CONNECT_SDK,
		}),
	],
	openapi: {
		href: "/openapi/connect.json",
		source: {
			path: `${OPENAPI}/connect.json`,
			quote: "Your Connect base URL. There is no default hosted URL.",
		},
	},
	limits: {
		title: "Rates and key limits",
		rows: [
			{
				label: "Natively served toolkit calls",
				value: ENGLISH_LIMIT_VALUES.connectNativeCalls,
				note: "No Composio add-ons apply to them.",
				source: PRICING_SOURCE,
			},
			{
				label: "Composio executions",
				value: "At the published Composio rates",
				note: "Premium tools add their exact reported provider charge.",
				source: {
					path: PRICING_SOURCE.path,
					quote: "each Composio execution at the published Composio rates",
				},
			},
			{
				label: "Starter credit",
				value: "None",
				note: "Creating a key needs credit on the organization.",
				source: {
					path: CONNECT,
					quote: "There is no free starter credit.",
				},
			},
			{
				label: "Access tokens",
				value: "10 minutes",
				note: "For a member or an OAuth client, instead of a long-lived key.",
				source: { path: CONNECT, quote: "10-minute [access token]" },
			},
			{
				label: "Rotation grace",
				value: "None, 1 hour, or 24 hours",
				source: {
					path: CONNECT,
					quote:
						"The old key stops at once, or after a grace period of 1 or 24 hours",
				},
			},
		],
	},
	quickstart: [
		{
			title: "Create a Connect key",
			description:
				"Where your organization has hosted Connect, create a key under Connect keys in the Ryu console. It is shown once.",
			source: {
				path: CONNECT,
				quote:
					"members create Connect keys in the Ryu console under **Connect keys** in their organization.",
			},
		},
		{
			title: "Export the URL and key",
			description:
				"Use the Connect URL Ryu issued. The key is never sent to another origin.",
			command: 'export RYU_CONNECT_API_KEY="<your runtime key>"',
			source: {
				path: CONNECT_SDK,
				quote: 'export RYU_CONNECT_API_KEY="<your runtime key>"',
			},
		},
		{
			title: "Give your agent the operating guide",
			description:
				"The ryu-connect Skill explains what calls cost, which failures to retry, and connection prompts.",
			source: {
				path: CONNECT,
				quote: "Point an agent at `GET /v1/skills/ryu-connect`",
			},
		},
		{
			title: "Point an MCP client at /mcp",
			description:
				"Existing MCP clients get the hosted Skills and your granted tools with the same key.",
			source: {
				path: CONNECT_SDK,
				quote: "Point your MCP client there with the runtime key;",
			},
		},
	],
	compareSlugs: ["composio"],
	related: [
		{
			label: "How to connect AI agents to your tools with MCP",
			href: "/blog/how-to-connect-ai-agents-tools-mcp",
			kind: "blog",
		},
		{
			label: "MCP tools: a connection and permission checklist",
			href: "/blog/best-mcp-servers-tools",
			kind: "blog",
		},
		{
			label: "What is MCP?",
			href: "/blog/what-is-mcp-model-context-protocol",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "Ryu Connect",
			path: "/docs/standalone/connect",
			description: "Lanes, keys, and natively served toolkits.",
		},
		{
			label: "Connect SDK quickstart",
			path: "/docs/standalone/sdk/connect",
			description: "A first call with curl and the SDK.",
		},
		{
			label: "Connect MCP",
			path: "/docs/standalone/connect-api-mcp",
			description: "Hosted MCP, Skill resources, and masking.",
		},
	],
};
