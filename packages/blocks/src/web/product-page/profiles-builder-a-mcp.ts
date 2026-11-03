import type { ProductProfile } from "./profile-types.ts";

/**
 * The MCP profile (unit builder-a), kept beside ./profiles-builder-a.ts so that
 * file stays small. The page leads with the three ways an MCP host reaches a
 * Ryu node: the stdio bridge, Core's HTTP endpoint, and the hosted OAuth URL.
 */

const DOCS = "apps/fumadocs/content/docs";
const MCP_QUICKSTART = `${DOCS}/extend/mcp/quickstart.mdx`;
const INTEGRATION_GUIDE = `${DOCS}/extend/develop/agent-integration-guide.mdx`;
const CHOOSE_SDK = `${DOCS}/standalone/sdk/choose-an-sdk.mdx`;
const CLI_REFERENCE = `${DOCS}/surfaces/cli/reference.mdx`;

const STDIO_CONFIG = `{
  "mcpServers": {
    "ryu": {
      "command": "ryu-mcp",
      "args": ["serve"],
      "env": {
        "RYU_CORE_URL": "http://127.0.0.1:7980",
        "RYU_CORE_TOKEN": "your-node-bearer"
      }
    }
  }
}`;

const DIRECT_HTTP = `https://<node>/mcp/<agent-id>
Authorization: Bearer <node-or-paired-token>`;

export const MCP_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Bridge",
			value: "ryu-mcp, over stdio",
			source: {
				path: INTEGRATION_GUIDE,
				quote:
					"The `ryu-mcp` server exposes Core tools over MCP (Model Context Protocol) using the stdio",
			},
		},
		{
			label: "Direct endpoint",
			value: "https://<node>/mcp/<agent-id>",
			source: { path: MCP_QUICKSTART, quote: "https://<node>/mcp/<agent-id>" },
		},
		{
			label: "Managed nodes",
			value: "OAuth 2.1 with PKCE; the node never sees your token",
			source: {
				path: MCP_QUICKSTART,
				quote: "The original Better Auth token never goes to the node.",
			},
		},
		{
			label: "Protocol",
			value: "MCP 2026-07-28; older hosts can use 2025-06-18",
			source: {
				path: MCP_QUICKSTART,
				quote:
					"Older hosts can continue to use the `2025-06-18` initialize flow.",
			},
		},
		{
			label: "Before a tool runs",
			value: "Token, agent id, method, and allowlist are checked",
			source: {
				path: MCP_QUICKSTART,
				quote:
					"Core checks the token, the exact agent id, the MCP method capability, and the agent's allowlist before it runs a tool.",
			},
		},
		{
			label: "Write your own",
			value: "The MCP bridge in @ryuhq/sdk/mcp",
			source: {
				path: CHOOSE_SDK,
				quote:
					"To write your own MCP server in TypeScript, use the MCP bridge in",
			},
		},
	],
	code: [
		{
			id: "mcp-stdio-config",
			label: "Stdio bridge",
			language: "json",
			code: STDIO_CONFIG,
			source: { path: INTEGRATION_GUIDE, quote: '"command": "ryu-mcp",' },
		},
		{
			id: "mcp-direct-http",
			label: "Direct HTTP",
			language: "http",
			code: DIRECT_HTTP,
			source: {
				path: MCP_QUICKSTART,
				quote: "Authorization: Bearer <node-or-paired-token>",
			},
		},
		{
			id: "mcp-hosted-oauth",
			label: "Managed node",
			language: "http",
			code: "https://<ryu-service>/mcp/<node-id>/<agent-id>",
			source: {
				path: MCP_QUICKSTART,
				quote: "https://<ryu-service>/mcp/<node-id>/<agent-id>",
			},
		},
	],
	quickstart: [
		{
			title: "Start Desktop or Core",
			description:
				"The local Core URL is http://127.0.0.1:7980. On loopback, the bridge reads the node's credential itself.",
			source: {
				path: MCP_QUICKSTART,
				quote: "The default local Core URL is `http://127.0.0.1:7980`.",
			},
		},
		{
			title: "Add the bridge to your host",
			description:
				"Paste the stdio config into the host's mcpServers. The host can then list and call Ryu's tools.",
			source: {
				path: INTEGRATION_GUIDE,
				quote: "An MCP host can then list and call those tools.",
			},
		},
		{
			title: "Or let the CLI write it",
			description:
				"For a coding agent, ryu-cli prints the entry to paste, or writes it with connect.",
			command: "ryu-cli connect cursor --print",
			source: { path: CLI_REFERENCE, quote: "ryu-cli connect cursor --print" },
		},
		{
			title: "Sign the bridge in",
			description:
				"Optional, for account tools such as whoami. It does not replace the node credential.",
			command: "ryu-mcp login",
			source: { path: INTEGRATION_GUIDE, quote: "ryu-mcp login" },
		},
	],
	docs: [
		{
			label: "MCP quickstart",
			path: "/docs/extend/mcp/quickstart",
			description: "Stdio, direct HTTP, and hosted OAuth.",
		},
		{
			label: "Configuration",
			path: "/docs/extend/mcp/configuration",
			description: "Target selection and environment variables.",
		},
		{
			label: "Credentials and security",
			path: "/docs/extend/mcp/security",
			description: "Credential boundaries and revocation.",
		},
	],
	related: [
		{
			label: "What is MCP?",
			href: "/blog/what-is-mcp-model-context-protocol",
			kind: "blog",
		},
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
	],
	compareSlugs: ["composio"],
};
