import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type { ProductArchetypeId, ProductProfile } from "./profile-types.ts";
import { GATEWAY_PROFILE } from "./profiles-infrastructure-a-data.ts";

/**
 * Product profiles for Core, Gateway and Cloud
 * (unit infrastructure-a). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each page tells a different story: Core is the runtime you install (deploy
 * commands, the request path, ways to self-host); Gateway is the control point
 * (base-URL swap, a firewall refusal, self-hosted vs managed); Cloud is the
 * managed server (how a managed call is billed, Ryu keys vs your own keys).
 */
export const ARCHETYPE = "infrastructure" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"core",
	"gateway",
	"cloud",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const SELF_HOST = `${DOCS}/start-here/getting-started/self-host.mdx`;
const CORE_VS_GATEWAY = `${DOCS}/start-here/architecture/core-vs-gateway.mdx`;
const CORE_INDEX = `${DOCS}/core/index.mdx`;
const SANDBOX = `${DOCS}/core/sandbox.mdx`;
const ENCRYPTION = `${DOCS}/core/encryption-at-rest.mdx`;
const GATEWAY_SECURITY = `${DOCS}/gateway/security.mdx`;
const HOSTED_AGENTS = `${DOCS}/billing/hosted-agents.mdx`;
const CLOUD_COMPUTERS = `${DOCS}/billing/cloud-computers.mdx`;
const CATALOG = "packages/blocks/src/web/data/catalog/core-box.tsx";
const RYU_REPO = "https://github.com/amajorai/ryu";

const CORE_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Built as",
			value: "A local Rust service",
			source: {
				path: CORE_INDEX,
				quote: "is the local Rust backend that decides what runs",
			},
		},
		{
			label: "Listens on",
			value: "127.0.0.1:7980",
			source: {
				path: CORE_INDEX,
				quote: "Core listens on `127.0.0.1:7980` by default",
			},
		},
		{
			label: "Licence",
			value: "Apache-2.0",
			href: RYU_REPO,
			external: true,
			source: { path: "apps/core/Cargo.toml", quote: 'license = "Apache-2.0"' },
		},
		{
			label: "First run",
			value: "Downloads llama.cpp and Gemma 4, then chats locally",
			source: {
				path: CATALOG,
				quote:
					"On first run Core downloads llama.cpp and Gemma 4, then chats locally.",
			},
		},
		{
			label: "Default sandbox",
			value: "Wasmtime, no network or files unless granted",
			source: {
				path: SANDBOX,
				quote: "The default secure backend is [wasmtime](https://wasmtime.dev)",
			},
		},
	],
	architecture: {
		title: "Where a chat request goes",
		caption:
			"Agents without a redirect hook, such as Gemini CLI, make their own provider calls and bypass the Gateway.",
		nodes: [
			{
				label: "Client",
				detail:
					"Desktop, CLI, Island, Extension, or Mobile calls Core's HTTP API.",
			},
			{
				label: "Core",
				detail:
					"Picks the agent, assembles memory, and adds the tools it may use.",
			},
			{
				label: "Gateway",
				detail: "Applies routing, firewall, budgets, caching, and audit.",
			},
			{
				label: "Provider or local engine",
				detail: "Answers the model call.",
			},
			{
				label: "Back to the client",
				detail: "The response streams back through Core.",
			},
		],
		source: {
			path: CORE_VS_GATEWAY,
			quote:
				"The Gateway applies routing, firewall, budgets, caching, and audit, then calls the upstream provider.",
		},
	},
	code: [
		{
			id: "core-docker",
			label: "Single image",
			language: "bash",
			code: [
				"docker build -t ryu .",
				"docker run --read-only --cap-drop=ALL \\",
				"  --security-opt=no-new-privileges:true \\",
				"  --pids-limit=1024 \\",
				"  --tmpfs /tmp:rw,noexec,nosuid,nodev \\",
				"  --user 10001:10001 \\",
				"  -p 7980:7980 -v ryu-data:/data ryu",
			].join("\n"),
			source: {
				path: SELF_HOST,
				quote: "docker run --read-only --cap-drop=ALL \\",
			},
		},
		{
			id: "core-compose",
			label: "Core and Gateway",
			language: "bash",
			code: [
				"git clone https://github.com/amajorai/ryu",
				"cd ryu",
				'export GATEWAY_MASTER_KEY="$(openssl rand -hex 24)"',
				'export GATEWAY_RELAY_KEY="$(openssl rand -hex 24)"',
				'export GATEWAY_CORE_RELAY_KEY="$(openssl rand -hex 24)"',
				'export GATEWAY_CORE_PROOF_KEY="$(openssl rand -hex 24)"',
				"docker compose up --build",
			].join("\n"),
			source: {
				path: SELF_HOST,
				quote: 'export GATEWAY_CORE_PROOF_KEY="$(openssl rand -hex 24)"',
			},
		},
	],
	comparison: {
		title: "Three ways to run it yourself",
		rowHeader: "Self-hosted",
		columns: ["Single image", "Two services", "GitHub Codespaces"],
		rows: [
			{
				label: "What you run",
				values: [
					"One Core container",
					"Core and Gateway as Compose services",
					"Release binaries in a codespace",
				],
			},
			{
				label: "Gateway",
				values: [
					"Core runs it on loopback",
					"Its own service on port 7981, inside the Compose network",
					"Core runs it on loopback",
				],
			},
			{
				label: "Published port",
				values: [
					"7980 (Core)",
					"7980 (Core)",
					"7990 (web app) and 7980 (Core API), kept private",
				],
			},
			{
				label: "Setup",
				values: [
					"docker build, then docker run",
					"Four different random Gateway keys",
					"No commands and no Ryu account",
				],
			},
		],
		source: {
			path: SELF_HOST,
			quote: "The single image is the simplest self-hosted server shape.",
		},
	},
	security: {
		points: [
			{
				text: "Wasmtime is the default execution backend, with no network or file access unless a directory is preopened.",
				source: {
					path: SANDBOX,
					quote:
						"it has no network or filesystem access unless a directory is explicitly preopened",
				},
			},
			{
				text: "Invalid configuration or unavailable credential storage stops startup instead of starting an open service.",
				source: {
					path: GATEWAY_SECURITY,
					quote:
						"Invalid configuration or unavailable private credential storage refuses startup instead of starting an open service.",
				},
			},
			{
				text: "Chat messages, memory, and stored credentials are sealed on disk. Encryption at rest is partial today.",
				source: {
					path: ENCRYPTION,
					quote:
						"Encryption at rest is shipped in slices and is **partial today**.",
				},
			},
			{
				text: "The container image runs as an unprivileged user (UID 10001).",
				source: {
					path: SELF_HOST,
					quote: "The image already runs as UID `10001`",
				},
			},
		],
	},
	compareSlugs: ["ollama", "lm-studio", "hermes"],
	related: [
		{
			label: "Running coding agents side by side",
			href: "/guides/running-coding-agents-side-by-side",
			kind: "guide",
		},
		{
			label: "How to self-host AI agents for data privacy and compliance",
			href: "/blog/how-to-self-host-ai-agents-privacy-compliance",
			kind: "blog",
		},
		{
			label: "What is local-first AI?",
			href: "/blog/what-is-local-first-ai",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "Core internals",
			path: "/docs/core",
			description: "Map of every Core subsystem.",
		},
		{
			label: "Self-host a Ryu server",
			path: "/docs/start-here/getting-started/self-host",
			description: "Codespaces, Docker, Fly.io, and a single VPS.",
		},
		{
			label: "Core vs Gateway",
			path: "/docs/start-here/architecture/core-vs-gateway",
			description: "Which service owns what, and the known bypass.",
		},
		{
			label: "Execution backends",
			path: "/docs/core/sandbox",
			description: "Wasmtime, containers, microVMs, and remote workspaces.",
		},
	],
};

const CLOUD_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Included server",
			value: "One always-on Ryu server on Teams and Business",
			source: {
				path: HOSTED_AGENTS,
				quote:
					"Teams and Business each get one organization-specific Ryu server at every seat count",
			},
		},
		{
			label: "Regions",
			value: "EU or Singapore",
			source: { path: CATALOG, quote: "Run your node in the EU or Singapore." },
		},
		{
			label: "Members",
			value: "Up to 50 active per organization",
			source: {
				path: HOSTED_AGENTS,
				quote:
					"Teams and Business support up to 50 active organization members.",
			},
		},
		{
			label: "Backups",
			value: "Daily, the latest seven kept",
			source: {
				path: CLOUD_COMPUTERS,
				quote: "The provider keeps the most recent seven daily backups.",
			},
		},
		{
			label: "Dedicated capacity",
			value: "Dedicated or self-hosted on Enterprise",
			source: {
				path: HOSTED_AGENTS,
				quote: "Enterprise can use dedicated or self-hosted deployment",
			},
		},
	],
	architecture: {
		title: "How a managed model call is paid for",
		caption:
			"Every cloud computer in an organization draws on the same organization wallet.",
		nodes: [
			{
				label: "Cloud computer",
				detail: "An always-on Ryu server for your organization.",
			},
			{
				label: "Organization binding",
				detail:
					"Tells the Gateway which organization wallet to check and debit.",
			},
			{
				label: "Hosted Gateway",
				detail:
					"Runs the call under the computer's own organization credential.",
			},
			{
				label: "Model provider",
				detail: "Provider keys stay on Ryu's side, never on the computer.",
			},
		],
		source: {
			path: CLOUD_COMPUTERS,
			quote:
				"its organization binding tells the Gateway which organization balance to check and debit",
		},
	},
	comparison: {
		title: "Ryu's keys or your own",
		rowHeader: "On a cloud computer",
		columns: ["Managed by Ryu", "Bring your own keys"],
		rows: [
			{
				label: "Model requests",
				values: [
					"Run through Ryu's hosted Gateway",
					"Run only with the provider keys you add",
				],
			},
			{
				label: "Provider keys",
				values: [
					"Stay on Ryu's side",
					"Added on the server after it boots, never in the browser",
				],
			},
			{
				label: "What pays for usage",
				values: [
					"Your organization wallet",
					"Your own provider balances, not Ryu credit",
				],
			},
		],
		source: {
			path: CLOUD_COMPUTERS,
			quote:
				"A cloud computer never holds Ryu's own provider keys in either mode.",
		},
	},
	security: {
		points: [
			{
				text: "Every hosted request carries an organization identity, and calls without one fail closed.",
				source: {
					path: HOSTED_AGENTS,
					quote:
						"Queries and service-to-service calls fail closed when the organization is missing",
				},
			},
			{
				text: "A cloud computer never holds Ryu's own provider keys.",
				source: {
					path: CLOUD_COMPUTERS,
					quote:
						"A cloud computer never holds Ryu's own provider keys in either mode.",
				},
			},
			{
				text: "Local model execution is off by default on shared hosted capacity.",
				source: {
					path: HOSTED_AGENTS,
					quote:
						"Local model execution is off by default on shared hosted capacity.",
				},
			},
		],
	},
	compareSlugs: ["instacloud"],
	related: [
		{
			label: "How to deploy AI agents without a platform team",
			href: "/blog/how-to-deploy-ai-agents-without-platform-team",
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
			label: "Hosted agent deployments",
			path: "/docs/billing/hosted-agents",
			description: "Seats, the organization boundary, and isolation.",
		},
		{
			label: "Cloud computers",
			path: "/docs/billing/cloud-computers",
			description: "Regions, backups, resizing, and key modes.",
		},
		{
			label: "Plans and pricing",
			path: "/docs/billing/plans",
			description: "Which plans include a cloud computer.",
		},
	],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	core: CORE_PROFILE,
	gateway: GATEWAY_PROFILE,
	cloud: CLOUD_PROFILE,
};
