import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type { ProductArchetypeId, ProductProfile } from "./profile-types.ts";
import { RED_TEAM_PROFILE } from "./profiles-infrastructure-b-data.ts";

/**
 * Product profiles for Red Team and Agents as a Service
 * (unit infrastructure-b). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each page tells a different story: Red Teaming is a test harness (the CI
 * gate command, a failing run in the terminal, the ten probes and the five
 * evaluators that score them); Agents as a Service is an engagement (from your
 * brief to a running agent, and where that agent can live afterwards).
 * Red Teaming's profile lives in ./profiles-infrastructure-b-data.ts.
 */
export const ARCHETYPE = "infrastructure" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"red-team",
	"agents-as-a-service",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const START_HERE = `${DOCS}/start-here/index.mdx`;
const OPEN_CORE = `${DOCS}/start-here/architecture/open-core.mdx`;
const COMMAND_APPROVAL = `${DOCS}/security/command-approval.mdx`;
const AAAS_CATALOG = "packages/blocks/src/web/data/catalog/notify-hire.tsx";
const CLOUD_CATALOG = "packages/blocks/src/web/data/catalog/core-box.tsx";
const EXPLAINERS =
	"packages/blocks/src/web/product-page/explainers-platform.ts";

const AGENTS_AS_A_SERVICE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "What it is",
			value: "Hands-on help scoping and setting up your first agent",
			source: {
				path: EXPLAINERS,
				quote: "Agents as a Service is hands-on help with your first agent.",
			},
		},
		{
			label: "You bring",
			value: "The task, and the tools it uses",
			source: {
				path: AAAS_CATALOG,
				quote: "Tell us the task and the tools it uses.",
			},
		},
		{
			label: "Approvals",
			value: "We agree which steps wait for you",
			source: {
				path: AAAS_CATALOG,
				quote: "We agree which steps wait for your approval.",
			},
		},
		{
			label: "Built on",
			value: "Ryu's memory, model routing, and Gateway security",
			source: {
				path: AAAS_CATALOG,
				quote: "Uses Ryu's memory, model routing, and Gateway security.",
			},
		},
		{
			label: "Runs on",
			value: "A Ryu Cloud node or your own machines",
			source: {
				path: AAAS_CATALOG,
				quote: "Runs on a Ryu cloud node or on your own machines.",
			},
		},
		{
			label: "Yours to keep",
			value: "Standard Ryu, so you can take it in-house",
			source: {
				path: AAAS_CATALOG,
				quote: "Standard Ryu underneath, so you can take it in-house.",
			},
		},
	],
	architecture: {
		title: "From your brief to a running agent",
		caption:
			"Every step uses standard Ryu, the same Core and Gateway you can self-host.",
		nodes: [
			{
				label: "Your brief",
				detail: "You describe the task and the tools it uses.",
			},
			{
				label: "Approval points",
				detail: "Together we agree which steps wait for your approval.",
			},
			{
				label: "Built on Ryu",
				detail:
					"The agent uses Ryu's memory, model routing, and Gateway security.",
			},
			{
				label: "Where it runs",
				detail: "A Ryu Cloud node, or your own machines.",
			},
			{
				label: "Yours to keep",
				detail: "Standard Ryu underneath, so you can take it in-house.",
			},
		],
		source: {
			path: EXPLAINERS,
			quote:
				"Tell us the task and the tools it uses, and we help scope and set it up on standard Ryu, so you can take it in-house later.",
		},
	},
	comparison: {
		title: "Where your agent can live",
		rowHeader: "After setup",
		columns: ["Ryu Cloud node", "Your own machines"],
		rows: [
			{
				label: "What runs it",
				values: [
					"A managed Ryu Cloud node",
					"A self-hosted node with Core and Gateway",
				],
			},
			{
				label: "Where",
				values: ["The EU or Singapore", "Wherever you run your servers"],
			},
			{
				label: "Who keeps it running",
				values: ["Ryu", "Your team"],
			},
			{
				label: "What it is built on",
				values: [
					"Open-source Core and Gateway",
					"The same open-source Core and Gateway",
				],
			},
		],
		source: {
			path: START_HERE,
			quote:
				"Choose a managed Ryu Cloud node, a self-hosted node with Core and Gateway, or a private deployment",
		},
	},
	security: {
		points: [
			{
				text: "Before Core runs a shell command from a tool, the Gateway scans it and returns allow, deny, or approval required.",
				source: {
					path: COMMAND_APPROVAL,
					quote:
						"The scanner classifies the command and returns a verdict: allow, deny, or approval required.",
				},
			},
			{
				text: "A run with nobody watching cannot approve unscanned commands on its own.",
				source: {
					path: COMMAND_APPROVAL,
					quote:
						"This keeps a headless (non-interactive) run from auto-approving unscanned commands.",
				},
			},
			{
				text: "Core and Gateway are open source, so you can audit what runs and self-host it.",
				source: {
					path: OPEN_CORE,
					quote: "The open part is the part you need to audit and self-host.",
				},
			},
			{
				text: "A Ryu Cloud node runs in the EU or Singapore.",
				source: {
					path: CLOUD_CATALOG,
					quote: "Run your node in the EU or Singapore.",
				},
			},
		],
	},
	related: [
		{
			label: "How to deploy AI agents without a platform team",
			href: "/blog/how-to-deploy-ai-agents-without-platform-team",
			kind: "blog",
		},
		{
			label: "How to get an AI agent pilot through compliance sign-off",
			href: "/blog/how-to-get-ai-agent-pilot-through-compliance",
			kind: "blog",
		},
		{
			label: "Managing a team of agents",
			href: "/guides/managing-a-team-of-agents",
			kind: "guide",
		},
	],
	docs: [
		{
			label: "Start here",
			path: "/docs/start-here",
			description: "Install Ryu, run an agent, and choose where it runs.",
		},
		{
			label: "Command approval",
			path: "/docs/security/command-approval",
			description: "How steps stop and wait for a person.",
		},
		{
			label: "Self-host a Ryu server",
			path: "/docs/start-here/getting-started/self-host",
			description: "Run Core and Gateway on your own machines.",
		},
		{
			label: "Open core",
			path: "/docs/start-here/architecture/open-core",
			description: "Which parts of Ryu are open source.",
		},
	],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	"red-team": RED_TEAM_PROFILE,
	"agents-as-a-service": AGENTS_AS_A_SERVICE_PROFILE,
};
