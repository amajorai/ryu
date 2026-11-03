import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type { ProductArchetypeId, ProductProfile } from "./profile-types.ts";
import { WORKFLOWS_PROFILE } from "./profiles-builder-b-workflows.ts";

/**
 * Product profiles for Extensions, Agents and Workflows
 * (unit builder-b). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each page opens on a different kind of code: Extensions on the manifest.json
 * you write and the Core calls that install it, Agents on the ryu-cli agents
 * commands and the agent entry an app ships, and Workflows (in a sibling file)
 * on the workflow itself as data.
 */
export const ARCHETYPE = "builder" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"extensions",
	"agents",
	"workflows",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const EXT_INDEX = `${DOCS}/extend/develop/extensions/index.mdx`;
const MANIFEST = `${DOCS}/extend/develop/extensions/plugin-json-manifest.mdx`;
const LIFECYCLE = `${DOCS}/extend/develop/extensions/plugin-lifecycle.mdx`;
const AGENTS_GUIDE = `${DOCS}/surfaces/desktop/user-guide/agents.mdx`;
const CREATE_AGENT = `${DOCS}/surfaces/desktop/user-guide/create-agent.mdx`;
const AGENT_COMMANDS = `${DOCS}/surfaces/cli/agent-commands.mdx`;
const BUILD_BY_CHAT = `${DOCS}/learn/cookbook/build-an-agent-by-chatting.mdx`;
const PLUGIN_API = `${DOCS}/extend/develop/sdk/plugin-api.mdx`;

const RESEARCH_MANIFEST = `{
  "id": "@example/research-assistant",
  "name": "Research Assistant",
  "version": "1.0.0",
  "runnables": [
    {
      "id": "agent-researcher",
      "name": "Researcher",
      "kind": "agent",
      "config": {
        "system_prompt": "You are a research assistant.",
        "model": "gemma4",
        "tools": ["web_search"]
      }
    },
    {
      "id": "tool-web-search",
      "name": "Web Search",
      "kind": "tool",
      "config": { "slug": "web_search" }
    }
  ],
  "permission_grants": ["mcp:web_search"]
}`;

const INSTALL_AND_ENABLE = `# Install: Core fetches the manifest, validates the schema, writes it under
# the data folder's plugins/ directory, and hot-reloads (no restart needed).
curl -X POST http://localhost:7980/api/plugins/install \\
  -H "Authorization: Bearer $RYU_CORE_TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"url": "https://example.com/research-assistant/manifest.json"}'

# Enable: validate grants via the Gateway, then activate the plugin.
curl -X POST http://localhost:7980/api/plugins/@example/research-assistant/enable \\
  -H "Authorization: Bearer $RYU_CORE_TOKEN"`;

const TOOL_FILTERS = `{
  "contributes": {
    "tool_filters": [
      { "tool": "shell.exec", "reason": "Shell execution is disabled while this policy is on" },
      { "tool": "shadow.*", "reason": "Removes the entire shadow server namespace" }
    ]
  }
}`;

const EXTENSIONS_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Ways in",
			value: "An MCP server, a manifest.json, or the TypeScript SDK",
			source: {
				path: EXT_INDEX,
				quote: "There are three ways to extend Ryu, and they combine:",
			},
		},
		{
			label: "Manifest",
			value: "manifest.json with an id, a name and a semver version",
			source: {
				path: MANIFEST,
				quote:
					"Create a `manifest.json` with the three required top-level fields plus an empty `runnables` array.",
			},
		},
		{
			label: "Permissions",
			value: "Declared by the plugin, checked by the Gateway on enable",
			source: {
				path: MANIFEST,
				quote: "Core decides what runs; the Gateway decides what is allowed.",
			},
		},
		{
			label: "Turn on and off",
			value: "Enable and disable apply on the next turn, no restart",
			source: {
				path: LIFECYCLE,
				quote:
					"so enable and disable take effect on the next turn with no restart",
			},
		},
		{
			label: "Inline tools",
			value: "Plugin JavaScript runs in a deny-by-default sandbox",
			source: {
				path: MANIFEST,
				quote: "Core runs that body in its deny-by-default JavaScript sandbox",
			},
		},
		{
			label: "Ryu version",
			value: "Pinned with engines.ryu, a semver range",
			source: {
				path: MANIFEST,
				quote: "`engines.ryu` is a semver requirement string",
			},
		},
	],
	code: [
		{
			id: "extensions-manifest",
			label: "manifest.json",
			language: "json",
			filename: "manifest.json",
			code: RESEARCH_MANIFEST,
			source: {
				path: MANIFEST,
				quote: '"permission_grants": ["mcp:web_search"]',
			},
		},
		{
			id: "extensions-install",
			label: "Install and enable",
			language: "bash",
			code: INSTALL_AND_ENABLE,
			source: {
				path: MANIFEST,
				quote:
					"curl -X POST http://localhost:7980/api/plugins/@example/research-assistant/enable \\",
			},
		},
		{
			id: "extensions-tool-filters",
			label: "Hide tools",
			language: "json",
			code: TOOL_FILTERS,
			source: {
				path: MANIFEST,
				quote:
					'{ "tool": "shadow.*", "reason": "Removes the entire shadow server namespace" }',
			},
		},
	],
	quickstart: [
		{
			title: "Write the manifest",
			description:
				"Start with an id such as @example/research-assistant, a display name, a semver version, and an empty list of agents, tools and workflows.",
			source: {
				path: MANIFEST,
				quote: "The `id` is a scoped id such as `@example/research-assistant`",
			},
		},
		{
			title: "Declare what it needs",
			description:
				"List each grant in permission_grants. Extra access a person may approve later goes in optional_permission_grants and starts off.",
			source: { path: MANIFEST, quote: "Optional grants start off." },
		},
		{
			title: "Pack it",
			description: "Validates the manifest and writes an installable bundle.",
			command: "bunx ryu pack .",
			source: { path: MANIFEST, quote: "bunx ryu pack ." },
		},
		{
			title: "Install it on your node",
			description:
				"Side-loads the bundle into your local node and enables it. This command is newer than the 0.3.0 release on npm; installing by URL with the Core calls above works without it.",
			command: "bunx ryu install . --enable",
			source: { path: MANIFEST, quote: "bunx ryu install . --enable" },
		},
		{
			title: "Check it is live",
			description:
				"The plugin shows up in GET /api/plugins straight away. If the Gateway denies a grant, enable fails and the plugin stays off.",
			source: {
				path: MANIFEST,
				quote:
					"Enable fails closed if any declared grant is denied by the Gateway.",
			},
		},
	],
	docs: [
		{
			label: "Extensions overview",
			path: "/docs/extend/develop/extensions",
			description: "MCP servers, manifests, and the SDK, and when to use each.",
		},
		{
			label: "Bundle with manifest.json",
			path: "/docs/extend/develop/extensions/plugin-json-manifest",
			description: "Every field, grants, contribution points, and install.",
		},
		{
			label: "Plugin lifecycle routes",
			path: "/docs/extend/develop/extensions/plugin-lifecycle",
			description:
				"Install, enable, disable, and update, and what each one does.",
		},
		{
			label: "Plugins vs apps",
			path: "/docs/extend/develop/extensions/plugins-vs-apps",
			description: "Which one you are building, and why it matters.",
		},
	],
	related: [
		{
			label: "Ryu Interfaces: build your own",
			href: "/blog/ryu-interfaces",
			kind: "blog",
		},
		{
			label: "Connect agents to your tools with MCP",
			href: "/blog/how-to-connect-ai-agents-tools-mcp",
			kind: "blog",
		},
		{
			label: "Ryu for engineering teams",
			href: "/guides/ryu-for-engineering",
			kind: "guide",
		},
	],
};

const AGENT_COMMAND_LINES = `ryu-cli agents create <name> [--identity <mode>] [--engine <id>] [--model <id>]
ryu-cli agents show <id>
ryu-cli agents access <id> available
ryu-cli agents access <id> add <key>…
ryu-cli agents access <id> none`;

const AGENT_ENTRY = `{
  "id": "io.example.researcher",
  "name": "Researcher",
  "kind": "agent",
  "config": {
    "system_prompt": "You are a careful researcher.",
    "model": "gemma4",
    "tools": ["web_search"],
    "identity_mode": "individual"
  }
}`;

const AGENTS_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Identity",
			value: "Acts as you, its own identity, or both",
			source: {
				path: CREATE_AGENT,
				quote:
					"Under **How should this agent work?**, choose one of three options.",
			},
		},
		{
			label: "Starts in",
			value: "Trial, with read-only access",
			source: {
				path: AGENTS_GUIDE,
				quote:
					"Every new or imported agent starts in **Trial** with **Read-only** access.",
			},
		},
		{
			label: "Tools",
			value: "None until you grant them",
			source: {
				path: AGENTS_GUIDE,
				quote:
					"New, imported, published, and auto-installed agents start with no MCP tools.",
			},
		},
		{
			label: "Safety profiles",
			value: "Read-only, approval required, verified plans only, autonomous",
			source: {
				path: AGENTS_GUIDE,
				quote: "The safety profile controls Active agents:",
			},
		},
		{
			label: "Routines",
			value: "A cron or interval, with an optional model pin",
			source: {
				path: AGENTS_GUIDE,
				quote:
					"contains a cron expression or interval, custom instructions, an optional model pin",
			},
		},
		{
			label: "Versions",
			value: "Restore an agent's earlier settings",
			source: {
				path: AGENTS_GUIDE,
				quote: "you can restore the previous settings from **Versions**",
			},
		},
	],
	code: [
		{
			id: "agents-cli",
			label: "From the terminal",
			language: "bash",
			code: AGENT_COMMAND_LINES,
			source: {
				path: AGENT_COMMANDS,
				quote:
					"ryu-cli agents create <name> [--identity <mode>] [--engine <id>] [--model <id>]",
			},
		},
		{
			id: "agents-app-entry",
			label: "Ship one in an app",
			language: "json",
			filename: "manifest.json",
			code: AGENT_ENTRY,
			source: {
				path: PLUGIN_API,
				quote: '"system_prompt": "You are a careful researcher."',
			},
		},
	],
	quickstart: [
		{
			title: "Start a new agent",
			description: "Open the Agents page from the sidebar and click +.",
			source: {
				path: CREATE_AGENT,
				quote: "On the Agents page, click **+** to create a new agent.",
			},
		},
		{
			title: "Choose how it works",
			description:
				"Acts as you uses the accounts you have connected. Its own identity gets its own accounts and never touches yours. Both does each, within limits you set.",
			source: {
				path: CREATE_AGENT,
				quote:
					"**Its own identity**: gets its own accounts and logins, and never touches yours.",
			},
		},
		{
			title: "Name it and write its instructions",
			description:
				"Pick the model and provider from the same composer, or describe the agent in the builder chat and let it set the model, tools and persona.",
			source: {
				path: BUILD_BY_CHAT,
				quote:
					"chat on the agent edit page sets the agent's model, tools, and persona for you.",
			},
		},
		{
			title: "Test it in Trial",
			description:
				"Trial can read and preview, but cannot change data, send messages, or run in the background.",
			source: {
				path: AGENTS_GUIDE,
				quote:
					"**Trial** is for testing. It can read and preview, but it cannot change data, send messages, or run in the background.",
			},
		},
		{
			title: "Promote it to Active",
			description:
				"An Active agent runs in chat, schedules, workflows, channels, and delegated work, under the safety profile you chose.",
			source: {
				path: AGENTS_GUIDE,
				quote:
					"**Active** lets the agent run in chat, schedules, workflows, channels, and delegated work.",
			},
		},
	],
	docs: [
		{
			label: "Agents",
			path: "/docs/surfaces/desktop/user-guide/agents",
			description: "Instructions, models, tools, memory, and safety.",
		},
		{
			label: "Create an agent",
			path: "/docs/surfaces/desktop/user-guide/create-agent",
			description:
				"The new-agent dialog, identity choices, and the engine check.",
		},
		{
			label: "Agent commands",
			path: "/docs/surfaces/cli/agent-commands",
			description:
				"ryu-cli agents: identity and account access from the terminal.",
		},
		{
			label: "Build an agent by chatting",
			path: "/docs/learn/cookbook/build-an-agent-by-chatting",
			description: "Describe the agent and let the builder set it up.",
		},
	],
	related: [
		{
			label: "Managing a team of agents",
			href: "/guides/managing-a-team-of-agents",
			kind: "guide",
		},
		{
			label: "Set per-agent budgets",
			href: "/blog/how-to-set-per-agent-budgets",
			kind: "blog",
		},
		{
			label: "Give agents long-term memory",
			href: "/blog/how-to-give-ai-agents-long-term-memory",
			kind: "blog",
		},
	],
	compareSlugs: ["openai-agent-builder", "copilot-studio", "lindy"],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	extensions: EXTENSIONS_PROFILE,
	agents: AGENTS_PROFILE,
	workflows: WORKFLOWS_PROFILE,
};
