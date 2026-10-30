import type { LibrarySection } from "./library-sections.ts";

/** Each built-in collection's empty-state line. Exhaustive over `LibrarySection`,
 *  so a new tab cannot be added without deciding what its empty state says. */
export const LIBRARY_EMPTY_COPY = {
	recents: "Items you open will show up here.",
	favorites: "Star an agent, workflow, chat, or anything else to pin it here.",
	wallpapers:
		"Install wallpapers from Marketplace to keep them in your Library.",
	agent: "Create your first agent to get started.",
	workflow: "Build an automation on the workflow canvas.",
	chat: "Start a new chat to see it here.",
	space: "Create a space to give your agents a knowledge base.",
	team: "Group several agents into a group.",
	meeting: "Record a meeting to get AI-written notes.",
	channel: "Connect a Telegram, Slack, WhatsApp, or Discord bot.",
	identity: "Save a login profile agents can reuse on the web.",
	// Never rendered — the Tools tab owns its own empty states — but the record is
	// exhaustive over LibrarySection so a new tab cannot be added without deciding
	// what its empty state says.
	tools: "Add an MCP server to give your agents new tools.",
	tabs: "Open a tab to keep it close at hand.",
	companions: "Install an app with a workspace surface to see it here.",
	projects: "Open a project folder to see it here.",
	pinned: "Pin a chat to keep it close at hand.",
	integrations: "Connect an integration to see it here.",
	skills: "Install a skill to see it here.",
	mcp: "Register an MCP server to see it here.",
	engines: "Add an engine to see it here.",
	archived: "Archived chats will show up here.",
	plugins: "Install an app or plugin to see it here.",
} satisfies Record<LibrarySection, string>;
