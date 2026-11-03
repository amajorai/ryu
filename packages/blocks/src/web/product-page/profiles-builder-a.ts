import type { StageProductSlug } from "../backgrounds/stage-routes.ts";
import type { ProductArchetypeId, ProductProfile } from "./profile-types.ts";
import { MCP_PROFILE } from "./profiles-builder-a-mcp.ts";
import { SKILLS_PROFILE } from "./profiles-builder-a-skills.ts";

/**
 * Product profiles for SDK, CLI, MCP and Skills
 * (unit builder-a). Every entry is grounded: each item names its source, and
 * ./profile-grounding.ts checks the file and quote exist. Prices are computed
 * from `PUBLISHED_PRICING`, never typed by hand. What a page needs:
 * `ARCHETYPE_REQUIREMENTS` in ./archetypes.ts and `profileGaps` in ./profiles.ts.
 *
 * Each page opens on a different kind of code: the SDK on TypeScript you write,
 * the CLI on shell commands you run in CI, MCP on the host config you paste,
 * and Skills on the SKILL.md file itself. MCP and Skills live in sibling files
 * so each file stays small.
 */
export const ARCHETYPE = "builder" satisfies ProductArchetypeId;

export const PROFILE_SLUGS = [
	"sdk",
	"cli",
	"mcp",
	"skills",
] as const satisfies readonly StageProductSlug[];

export type ProfileSlug = (typeof PROFILE_SLUGS)[number];

const DOCS = "apps/fumadocs/content/docs";
const SDK_INDEX = `${DOCS}/extend/develop/sdk/index.mdx`;
const SDK_QUICKSTART = `${DOCS}/extend/develop/quickstart.mdx`;
const SDK_RUNNABLES = `${DOCS}/extend/develop/sdk/runnables.mdx`;
const SDK_TOOLING = `${DOCS}/extend/develop/sdk/tooling.mdx`;
const CHOOSE_SDK = `${DOCS}/standalone/sdk/choose-an-sdk.mdx`;
const CLI_START = `${DOCS}/surfaces/cli/getting-started.mdx`;
const CLI_REFERENCE = `${DOCS}/surfaces/cli/reference.mdx`;

const STARTER_AGENT = `import { defineTool } from "@ryuhq/sdk";
import { Agent } from "@ryuhq/sdk/agent";

const MODEL_ID = process.env.RYU_MODEL ?? "gpt-4o-mini";
const WHITESPACE = /\\s+/;

const wordCount = defineTool<{ text: string }, { characters: number; words: number }>({
  id: "word-count",
  name: "Word Count",
  description: "Count the words and characters in a piece of text.",
  schema: {
    type: "object",
    properties: { text: { type: "string", description: "The text to measure" } },
    required: ["text"],
  },
  run({ text }) {
    const words = text.trim().split(WHITESPACE).filter(Boolean).length;
    return Promise.resolve({ words, characters: text.length });
  },
});

const agent = new Agent({
  name: "my-first-plugin",
  model: MODEL_ID,
  instructions: "You are a concise writing assistant running inside Ryu. ...",
  tools: { wordCount },
});`;

const DEFINE_AGENT = `const myAgent = defineAgent({
  id: "agent-researcher",
  name: "Researcher",
  async run({ query }, ctx) {
    const result = await ctx.gateway.chat([{ role: "user", content: query }]);
    return { answer: result.content };
  },
});`;

const SDK_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Package",
			value: "@ryuhq/sdk, written in TypeScript",
			source: {
				path: SDK_INDEX,
				quote: "`@ryuhq/sdk` (`packages/sdk/`) is the authoring package.",
			},
		},
		{
			label: "On npm",
			value: "0.3.0 is published; newer commands are not in it yet",
			source: {
				path: CHOOSE_SDK,
				quote: "| `@ryuhq/sdk` | npm | 0.3.0 is published.",
			},
		},
		{
			label: "Model calls",
			value: "Only through the Gateway",
			source: {
				path: SDK_INDEX,
				quote: "Every model call reaches a provider only through the Gateway.",
			},
		},
		{
			label: "Gateway default",
			value: "http://127.0.0.1:7981",
			source: {
				path: CHOOSE_SDK,
				quote: "The Gateway URL defaults to `http://127.0.0.1:7981`.",
			},
		},
		{
			label: "Build targets",
			value: "Node, Docker, Vercel, Cloudflare, Netlify",
			source: {
				path: SDK_TOOLING,
				quote:
					"bundle a project for `node`, `docker`, `vercel`, `cloudflare`, or `netlify`",
			},
		},
		{
			label: "Source",
			value: "amajorai/ryu-sdk",
			href: "https://github.com/amajorai/ryu-sdk",
			external: true,
			source: {
				path: SDK_INDEX,
				quote:
					"[`amajorai/ryu-sdk` public hub](https://github.com/amajorai/ryu-sdk)",
			},
		},
	],
	code: [
		{
			id: "sdk-starter-agent",
			label: "Starter agent",
			language: "ts",
			filename: "src/agent.ts",
			code: STARTER_AGENT,
			source: { path: SDK_QUICKSTART, quote: "const agent = new Agent({" },
		},
		{
			id: "sdk-define-agent",
			label: "defineAgent",
			language: "ts",
			code: DEFINE_AGENT,
			source: {
				path: SDK_RUNNABLES,
				quote:
					'const result = await ctx.gateway.chat([{ role: "user", content: query }]);',
			},
		},
	],
	quickstart: [
		{
			title: "Scaffold a plugin",
			description:
				"The name becomes the directory and the app id. The default template is a starter agent with one local tool.",
			command: "bunx create-ryu-app my-first-plugin",
			source: {
				path: SDK_QUICKSTART,
				quote: "bunx create-ryu-app my-first-plugin",
			},
		},
		{
			title: "Install dependencies",
			description: "This pulls @ryuhq/sdk into the project.",
			command: "cd my-first-plugin && bun install",
			source: { path: SDK_QUICKSTART, quote: "bun install" },
		},
		{
			title: "Run it against the Gateway",
			description:
				"One agent turn, calling the tool if the model asks for it. It needs a node whose Gateway can route a model.",
			command: "bun dev",
			source: { path: SDK_QUICKSTART, quote: "bun dev" },
		},
		{
			title: "Validate and bundle",
			description:
				"Checks manifest.json and writes dist/plugin.bundle.json, or names the failing field.",
			command: "bun run pack",
			source: { path: SDK_QUICKSTART, quote: "bun run pack" },
		},
		{
			title: "Install it in Ryu",
			description:
				"Side-loads the bundle into your local node and enables it. This command is newer than the 0.3.0 release on npm.",
			command: "bunx ryu install . --enable",
			source: { path: SDK_QUICKSTART, quote: "bunx ryu install . --enable" },
		},
	],
	docs: [
		{
			label: "Ryu SDKs and libraries",
			path: "/docs/extend/develop/sdk",
			description: "Packages, subpaths, and the shared contract.",
		},
		{
			label: "Quickstart: your first plugin",
			path: "/docs/extend/develop/quickstart",
			description: "Scaffold, run, pack, and install a plugin.",
		},
		{
			label: "SDK tooling",
			path: "/docs/extend/develop/sdk/tooling",
			description: "Every ryu command and create-ryu-app template.",
		},
		{
			label: "Choose an SDK",
			path: "/docs/standalone/sdk/choose-an-sdk",
			description:
				"Which package fits your job, and what you can install today.",
		},
	],
	related: [
		{ label: "Ryu vs LangChain", href: "/blog/ryu-vs-langchain", kind: "blog" },
		{
			label: "LangChain alternatives",
			href: "/blog/best-langchain-alternatives",
			kind: "blog",
		},
		{
			label: "Enterprise AI agent frameworks",
			href: "/blog/best-ai-agent-frameworks-enterprises",
			kind: "blog",
		},
	],
	compareSlugs: ["langchain", "mastra", "vercel-ai-sdk", "claude-agents"],
};

const EVAL_GATE = `ryu-cli eval support-agent gpt-4o-mini \\
  --dataset evals/support.jsonl \\
  --scorer answer_relevance --scorer toxicity \\
  --threshold 0.8 --threshold overall=0.7 \\
  --junit > ryu-eval.xml`;

const CONNECT_AGENTS = `ryu-cli connect claude-code          # write the entry
ryu-cli connect codex --dry-run      # show what would change, token redacted
ryu-cli connect cursor --print       # print the snippet to paste yourself
ryu-cli connect opencode --agent coder   # scope the tools to another Ryu agent
ryu-cli disconnect claude-code       # remove it again
ryu-cli doctor agents                # check every agent`;

const CLI_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Command",
			value: "ryu-cli, a Bun and OpenTUI terminal client",
			source: {
				path: CLI_START,
				quote: "`ryu-cli` is the Bun and OpenTUI terminal client for Ryu Core.",
			},
		},
		{
			label: "Installs with",
			value: "Ryu itself, not npm",
			source: {
				path: CHOOSE_SDK,
				quote: "Ship with Ryu. They are not npm packages.",
			},
		},
		{
			label: "Sign-in",
			value: "A device code you confirm in the browser",
			source: {
				path: CLI_START,
				quote: "The CLI prints a device code and verification URL.",
			},
		},
		{
			label: "Machine output",
			value: "--json, for agents and CI",
			source: {
				path: CLI_REFERENCE,
				quote: "| `--json` | Machine-readable output for agents and CI |",
			},
		},
		{
			label: "CI gates",
			value: "eval exits 1 when a threshold is missed",
			source: {
				path: CLI_REFERENCE,
				quote: "with `--threshold` it exits 1 when any threshold is missed",
			},
		},
		{
			label: "Updates",
			value: "Checked against SHA-256, applied on next launch",
			source: {
				path: CLI_START,
				quote:
					"The CLI verifies the downloaded release against its published SHA-256 file.",
			},
		},
	],
	code: [
		{
			id: "cli-eval-gate",
			label: "Gate CI on evals",
			language: "bash",
			code: EVAL_GATE,
			source: {
				path: CLI_REFERENCE,
				quote: "--threshold 0.8 --threshold overall=0.7 \\",
			},
		},
		{
			id: "cli-redteam-gate",
			label: "Red-team gate",
			language: "bash",
			code: "ryu-cli redteam <agent-id> --max-attention 0",
			source: {
				path: CLI_REFERENCE,
				quote: "ryu-cli redteam <agent-id> --max-attention 0",
			},
		},
		{
			id: "cli-coding-agents",
			label: "Coding agents",
			language: "bash",
			code: CONNECT_AGENTS,
			source: {
				path: CLI_REFERENCE,
				quote: "ryu-cli connect claude-code          # write the entry",
			},
		},
	],
	quickstart: [
		{
			title: "Install Ryu",
			description:
				"Install Ryu and start Core. ryu-cli uses the same node and account as the other Ryu clients.",
			source: {
				path: CLI_START,
				quote: "It uses the same node and account as the other Ryu clients.",
			},
		},
		{
			title: "Open the terminal client",
			description:
				"Chat opens by default. Ctrl+A picks an agent, Ctrl+K opens the command palette.",
			command: "ryu-cli",
			source: { path: CLI_START, quote: "ryu-cli" },
		},
		{
			title: "Sign in",
			description:
				"Confirm the device code at the URL it prints. Workspace commands then share Desktop's approval state.",
			command: "ryu-cli login",
			source: { path: CLI_START, quote: "ryu-cli login" },
		},
		{
			title: "Pick up anywhere",
			description:
				"Core saves the conversation, so you can resume it from Desktop or another client on the same node.",
			source: {
				path: CLI_START,
				quote:
					"Core saves the conversation, so you can resume it from Desktop or another client connected to the same node.",
			},
		},
	],
	docs: [
		{
			label: "Getting started",
			path: "/docs/surfaces/cli/getting-started",
			description: "Install, sign in, and start a chat.",
		},
		{
			label: "Command reference",
			path: "/docs/surfaces/cli/reference",
			description: "Every subcommand and global flag.",
		},
		{
			label: "The terminal client",
			path: "/docs/surfaces/cli/tui",
			description: "The shell, tabs, and keyboard map.",
		},
	],
	related: [
		{
			label: "Running coding agents side by side",
			href: "/guides/running-coding-agents-side-by-side",
			kind: "guide",
		},
		{
			label: "Ryu for engineering teams",
			href: "/guides/ryu-for-engineering",
			kind: "guide",
		},
		{
			label: "How to run Claude Code and Codex side by side",
			href: "/blog/how-to-run-claude-code-and-codex-side-by-side",
			kind: "blog",
		},
	],
	compareSlugs: ["claude-code", "codex", "opencode"],
};

export const PROFILES: Partial<Record<ProfileSlug, ProductProfile>> = {
	sdk: SDK_PROFILE,
	cli: CLI_PROFILE,
	mcp: MCP_PROFILE,
	skills: SKILLS_PROFILE,
};
