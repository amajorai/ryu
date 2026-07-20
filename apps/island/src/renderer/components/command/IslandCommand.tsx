// The island's command surface: a Cmd+K-style palette that morphs into a mini
// chat, rendered inside the expanded island. It is the merged-in replacement for
// the old standalone `apps/command` "Golden Gate" bar — same shared @ryu/blocks
// command-bar shell + @ryu/command palette/chat, but hosted in the island window
// and talking to Core through `window.island`.
//
// It owns all Core access here (agents/conversations + the injected IPC
// transport) and reuses the island's existing agent preference (`island-agents`,
// the `voiceAgent` slot) so the command chat routes to the same agent as the
// island's other chat surfaces — one ambient surface, one agent choice.

import { CommandBar as CommandBarShell } from "@ryu/blocks/command/command-bar";
// The pure routing engine is re-exported from the `smart-bar` block (the bundler
// resolves the `.tsx` subpath; the bare `.ts` engine path is not in the export
// map's resolvable set). We only use `route`/`SmartIntent`, not the component.
import { route, type SmartIntent } from "@ryu/blocks/extension/smart-bar";
import type { CommandAction } from "@ryu/command/types";
import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { parseIslandAgentPrefs } from "../../../shared/agents.ts";
import { createCommandTransport } from "../../command-transport.ts";
import { useIslandState } from "../../store/island-state.ts";

type Mode = "palette" | "chat";

/** A unique conversation id (Electron's crypto is available in the renderer). */
function newConversationId(): string {
	return crypto.randomUUID();
}

/** How many recent conversations to surface as palette rows. */
const MAX_RECENT = 6;

/** A readable row title for a smart-bar intent (Dia/Chrome-style suggestion). */
function intentTitle(intent: SmartIntent): string {
	switch (intent.kind) {
		case "navigate":
		case "bang":
		case "mention":
			return intent.label;
		case "search":
			return `Search the web for "${intent.query}"`;
		case "skill":
			return intent.name ? `Run /${intent.name}` : "Pick a skill";
		default:
			return intent.prompt.trim().length > 0
				? `Ask Ryu: "${intent.prompt}"`
				: "Ask Ryu…";
	}
}

/** A short right-aligned kind hint shown on each suggestion row. */
function intentHint(intent: SmartIntent): string {
	switch (intent.kind) {
		case "navigate":
		case "bang":
			return "Open";
		case "search":
			return "Web";
		case "skill":
			return "Skill";
		default:
			return "Ask";
	}
}

/**
 * Whether an intent leaves Ryu (a web navigation) vs starts a chat turn. The
 * navigate/search/bang intents resolve to a URL the OS opens; ai/skill/mention
 * seed a chat. Mirrors the extension's `executeIntent` split.
 */
function isWebIntent(
	intent: SmartIntent
): intent is Extract<SmartIntent, { url: string }> {
	return (
		intent.kind === "navigate" ||
		intent.kind === "search" ||
		intent.kind === "bang"
	);
}

/** The chat prompt to seed for a non-web intent. */
function intentPrompt(intent: SmartIntent): string {
	if (intent.kind === "skill") {
		return `/${intent.name} ${intent.rest}`.trim();
	}
	if (intent.kind === "mention") {
		return intent.rest;
	}
	if (intent.kind === "ai") {
		return intent.prompt;
	}
	return "";
}

/** Case-insensitive substring match used to narrow the static palette rows. */
function matchesQuery(haystack: string, query: string): boolean {
	return haystack.toLowerCase().includes(query.toLowerCase());
}

export function IslandCommand() {
	const setState = useIslandState((store) => store.setState);

	const [mode, setMode] = useState<Mode>("palette");
	const [search, setSearch] = useState("");
	const [agents, setAgents] = useState<
		{ id: string; name: string; recommended: boolean }[]
	>([]);
	const [conversations, setConversations] = useState<
		{ id: string; title: string }[]
	>([]);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [conversationId, setConversationId] = useState(newConversationId);
	const [initialPrompt, setInitialPrompt] = useState<string | undefined>(
		undefined
	);

	// Load palette data + the configured agent on mount.
	useEffect(() => {
		window.island.core.agents().then((res) => {
			if (res.available) {
				setAgents(
					res.agents.map((a) => ({
						id: a.id,
						name: a.name,
						recommended: a.recommended,
					}))
				);
			}
		});
		window.island.core.conversations().then((res) => {
			if (res.available) {
				setConversations(res.conversations.slice(0, MAX_RECENT));
			}
		});
		window.island.agents.get().then((raw) => {
			const prefs = parseIslandAgentPrefs(raw);
			setAgentId(prefs.voiceAgent.length > 0 ? prefs.voiceAgent : null);
		});
	}, []);

	const transport = useMemo(
		() => createCommandTransport({ agentId, conversationId }),
		[agentId, conversationId]
	);

	const startChat = useCallback(
		(
			prompt: string,
			options?: { agentId?: string; conversationId?: string }
		) => {
			if (options?.agentId !== undefined) {
				setAgentId(options.agentId);
			}
			setConversationId(options?.conversationId ?? newConversationId());
			setInitialPrompt(prompt.trim().length > 0 ? prompt.trim() : undefined);
			setMode("chat");
		},
		[]
	);

	const exitToPalette = useCallback(() => {
		setMode("palette");
		setSearch("");
		setInitialPrompt(undefined);
	}, []);

	// Carry out a smart-bar intent: a web intent opens the URL in the default
	// browser and folds the island back to its resting pill; everything else seeds
	// a chat turn. Mirrors the extension's `executeIntent` split.
	const runIntent = useCallback(
		(intent: SmartIntent) => {
			if (isWebIntent(intent)) {
				window.island.system.openExternal(intent.url);
				setState("idle");
				return;
			}
			startChat(intentPrompt(intent));
		},
		[setState, startChat]
	);

	// The palette is smart-bar driven (Dia/Chrome-style): the typed query is
	// classified into a primary intent + Tab-cycle alternatives (open URL / search
	// the web / ask Ryu / run a skill / @mention), shown first as deterministic
	// suggestion rows, then the static agents/recents/new-chat rows narrowed to the
	// query. cmdk's own fuzzy filter is bypassed (`shouldFilter={false}` below) so
	// the order — best guess on top — is exactly this list.
	const actions = useMemo<CommandAction[]>(() => {
		const trimmed = search.trim();
		const items: CommandAction[] = [];

		if (trimmed.length > 0) {
			const { primary, alternatives } = route(trimmed);
			let index = 0;
			for (const intent of [primary, ...alternatives]) {
				items.push({
					id: `intent-${index}`,
					group: "Suggestions",
					title: intentTitle(intent),
					trailing: intentHint(intent),
					value: `intent-${index}`,
					onSelect: () => runIntent(intent),
				});
				index++;
			}
		} else {
			items.push({
				id: "ask-ryu",
				group: "Suggestions",
				title: "Ask Ryu…",
				value: "ask-ryu",
				onSelect: () => startChat(""),
			});
		}

		for (const agent of agents) {
			if (trimmed.length > 0 && !matchesQuery(agent.name, trimmed)) {
				continue;
			}
			items.push({
				id: `agent-${agent.id}`,
				group: "Agents",
				title: agent.name,
				trailing: agent.recommended ? "default" : undefined,
				value: `agent-${agent.id}`,
				onSelect: () => startChat("", { agentId: agent.id }),
			});
		}

		for (const conv of conversations) {
			if (trimmed.length > 0 && !matchesQuery(conv.title, trimmed)) {
				continue;
			}
			items.push({
				id: `conv-${conv.id}`,
				group: "Recent",
				title: conv.title,
				value: `conv-${conv.id}`,
				onSelect: () => startChat("", { conversationId: conv.id }),
			});
		}

		items.push({
			id: "new-chat",
			group: "Actions",
			title: "New Chat",
			value: "new-chat",
			onSelect: () => startChat(""),
		});

		return items;
	}, [search, agents, conversations, startChat, runIntent]);

	const onPaletteKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Escape") {
			event.preventDefault();
			// The island persists: dismiss the command surface to the resting text
			// pill rather than hiding the window.
			setState("idle");
		}
	};

	return (
		<CommandBarShell
			actions={actions}
			agentLabel={agentId ?? "Ryu (default)"}
			// Flatten the shell's own frosted card: the island shape already provides
			// the glass surround, so strip the block's border/fill/shadow/blur.
			chatPlaceholder="Ask Ryu anything…"
			className="h-full rounded-none border-0 bg-transparent shadow-none ring-0 backdrop-blur-none"
			initialPrompt={initialPrompt}
			key={mode === "chat" ? conversationId : "palette"}
			mode={mode}
			onExit={exitToPalette}
			onInputKeyDown={onPaletteKeyDown}
			onSearchChange={setSearch}
			placeholder="Search or Ask"
			search={search}
			// The query is classified into ordered intent rows ourselves, so bypass
			// cmdk's fuzzy filter/sort and render the list verbatim (best guess first).
			shouldFilter={false}
			stream={transport}
		/>
	);
}
