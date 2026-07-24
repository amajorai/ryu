import {
	Add01Icon,
	AiBrain01Icon,
	ArrowRight01Icon,
	BotIcon,
	ComputerIcon,
	DollarCircleIcon,
	Download01Icon,
	Key01Icon,
	Logout01Icon,
	Moon01Icon,
	Package01Icon,
	PuzzleIcon,
	Settings01Icon,
	Sun01Icon,
	WebhookIcon,
} from "@hugeicons/core-free-icons";
import { renderTemplate } from "@ryu/app-host/views";
import { CommandPalette as SharedCommandPalette } from "@ryu/command/CommandPalette";
import type { CommandAction } from "@ryu/command/types";
import { useHotkey } from "@ryu/hotkeys/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import { toast } from "@ryu/ui/components/sileo";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { useAuthContext } from "@/contexts/auth-context.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useAgents } from "@/src/hooks/useAgents.ts";
import { useContributedSectionItems } from "@/src/hooks/useContributedCommands.ts";
import {
	pluginCompanionPath,
	usePluginContributions,
} from "@/src/hooks/usePluginContributions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type MessageSearchHit,
	searchConversations,
} from "@/src/lib/api/conversation-search.ts";
import { fireActivationEvent } from "@/src/lib/api/plugins.ts";
import { indexChunk } from "@/src/lib/api/retrieval.ts";
import { type ShadowSearchResult, searchShadow } from "@/src/lib/api/shadow.ts";
import { useGatewayDialog } from "@/src/store/useGatewayDialog.ts";
import { SettingsDialog } from "../settings/SettingsDialog.tsx";

/** Safely read a string field off an opaque plugin-contribution record. */
function contribString(
	record: Record<string, unknown>,
	key: string
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

type SettingsSection =
	| "appearance"
	| "profile"
	| "account"
	| "connections"
	| "sessions"
	| "authorized-apps"
	| "billing"
	| "credits"
	| "hardware"
	| "memory";

const NAV_ITEMS = [
	{ to: "/chat", label: "Chat", icon: Add01Icon },
	{ to: "/library/agent", label: "Agents", icon: BotIcon },
	{ to: "/engines", label: "Engines", icon: ArrowRight01Icon },
	{ to: "/models", label: "Models", icon: Package01Icon },
	{ to: "/skills", label: "Skills", icon: PuzzleIcon },
	{ to: "/library/space", label: "Spaces", icon: ArrowRight01Icon },
	{ to: "/library/memory", label: "Memory", icon: AiBrain01Icon },
	{ to: "/tools", label: "Tools", icon: ArrowRight01Icon },
	{ to: "/library/workflow", label: "Workflows", icon: ArrowRight01Icon },
	{ to: "/calendar", label: "Calendar", icon: ArrowRight01Icon },
	{ to: "/timeline", label: "Timeline", icon: ArrowRight01Icon },
	{ to: "/review", label: "Weekly review", icon: ArrowRight01Icon },
	{ to: "/monitors", label: "Monitors", icon: ArrowRight01Icon },
	{ to: "/quests", label: "Tasks", icon: ArrowRight01Icon },
	{ to: "/inbox", label: "Inbox", icon: ArrowRight01Icon },
	{ to: "/meetings", label: "Meetings", icon: ArrowRight01Icon },
	{ to: "/learning", label: "Learning", icon: ArrowRight01Icon },
] as const;

const MAX_CHAT_RESULTS = 30;

/** Split a folder path on either separator to show its last segment. */
const PATH_SEPARATOR = /[\\/]/;

/** Turn a snake_case capture kind (e.g. "clipboard_copy") into plain words. */
const SNAKE_CASE = /_/g;

/**
 * Human-readable label for a captured item when it has no title/snippet/app —
 * turns a raw `event_type` like "clipboard_copy" into "Clipboard copy" so a
 * first-time user never sees developer jargon in a result row.
 */
const humanizeCaptureKind = (eventType: string): string => {
	const words = eventType.replace(SNAKE_CASE, " ").trim();
	if (!words) {
		return "Captured item";
	}
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [settingsSection, setSettingsSection] =
		useState<SettingsSection>("appearance");
	const { openTab } = useTabsContext();
	const { agents } = useAgents();
	const { theme, setTheme } = useTheme();
	const { listConversations, setActiveConversationId } =
		useChatHistoryContext();
	const { handleSignOut, isSigningOut } = useAuthContext();
	const openGateway = useGatewayDialog((s) => s.openGateway);
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	// Enabled plugins' declarative contributions (companions + slash commands +
	// app-registered sidebar buttons), shared via react-query cache with the
	// route-registration hook in Layout.
	const {
		companions: pluginCompanions,
		slash_commands: pluginCommands,
		sidebar_buttons: contributedButtons,
	} = usePluginContributions();
	// Live items of every app-contributed sidebar section (meeting notes, canvas
	// boards, …), fetched only while the palette is open so they're searchable
	// here without the shell hardcoding a single list.
	const contributedSectionItems = useContributedSectionItems(open);
	const [query, setQuery] = useState("");
	const [pendingMemory, setPendingMemory] = useState<string | null>(null);
	const [shadowResults, setShadowResults] = useState<ShadowSearchResult[]>([]);
	const [messageResults, setMessageResults] = useState<MessageSearchHit[]>([]);
	const searchAbort = useRef<AbortController | null>(null);
	const messageAbort = useRef<AbortController | null>(null);

	// The palette toggle routes through the unified hotkey system so a rebind in
	// Settings → Keyboard Shortcuts retargets it live. The custom event stays for
	// the titlebar search button and tray actions that open the palette directly.
	useHotkey("command-palette.toggle", () => setOpen((prev) => !prev));

	useEffect(() => {
		const handleOpenEvent = () => setOpen(true);
		window.addEventListener("ryu:open-command-palette", handleOpenEvent);
		return () => {
			window.removeEventListener("ryu:open-command-palette", handleOpenEvent);
		};
	}, []);

	// Tray quick actions (Rust emits these from src-tauri/src/tray.rs).
	useEffect(() => {
		const unlistenTimeline = listen("tray-open-timeline", () => {
			openTab("/timeline");
		});
		const unlistenPalette = listen("tray-open-palette", () => setOpen(true));
		const ignore = () => {
			// Unlisten can fail if the window is already torn down; nothing to do.
		};
		return () => {
			unlistenTimeline.then((u) => u()).catch(ignore);
			unlistenPalette.then((u) => u()).catch(ignore);
		};
	}, [openTab]);

	// Debounced "search everything" against Shadow's captured context (window
	// titles, clipboard, files, git, terminal, OCR). Resolves to [] when Shadow
	// is not running so the palette still works as a plain command launcher.
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setShadowResults([]);
			return;
		}
		const handle = setTimeout(async () => {
			searchAbort.current?.abort();
			const controller = new AbortController();
			searchAbort.current = controller;
			const results = await searchShadow(q, 8, controller.signal);
			if (results) {
				setShadowResults(results);
			}
		}, 200);
		return () => clearTimeout(handle);
	}, [query]);

	// Debounced semantic search over past chat messages (matches by meaning, not
	// substring). Resolves to [] when Core has no message index or is unreachable,
	// so the palette degrades to a plain launcher.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `target` is a fresh object every render; depending on its primitive fields avoids an infinite update loop (see comment on the deps array below).
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setMessageResults([]);
			return;
		}
		const handle = setTimeout(async () => {
			messageAbort.current?.abort();
			const controller = new AbortController();
			messageAbort.current = controller;
			const result = await searchConversations(target, q, 8, controller.signal);
			if (result) {
				setMessageResults(result.hits);
			}
		}, 250);
		return () => clearTimeout(handle);
		// Primitive deps only — `target` is a fresh object every render, so listing
		// it would re-run this effect each render and the early `setMessageResults([])`
		// (a fresh array, never bailed) would spin into an infinite update loop.
	}, [query, target.url, target.token]);

	const close = () => {
		setOpen(false);
		setQuery("");
		setShadowResults([]);
		setMessageResults([]);
	};

	// Saving to memory is an explicit, confirmed action — never the silent default
	// for an unmatched query. Selecting it stashes the text and opens a confirm
	// dialog; the actual save happens (with feedback) only after the user agrees.
	const requestRemember = () => {
		const content = query.trim();
		if (!content) {
			return;
		}
		setPendingMemory(content);
		close();
	};

	const confirmRemember = async () => {
		const content = pendingMemory?.trim();
		setPendingMemory(null);
		if (!content) {
			return;
		}
		try {
			await indexChunk(target, { id: crypto.randomUUID(), content });
			toast.success("Saved to memory", { description: content });
		} catch {
			toast.error("Couldn't save to memory", {
				description: "Please check your connection and try again.",
			});
		}
	};

	// Open a captured item back in the timeline at the moment it happened. The
	// timeline is now a sandboxed companion (com.ryu.timeline); a shell window event
	// cannot cross the frame, so the timestamp rides the deep-link path (/timeline/:ts)
	// and the route bakes it into the frame's mount context as
	// `window.ryu.context.focusTs`, which the companion reads at mount to scrub
	// straight to that moment instead of dumping the user at "now".
	const handleOpenCapture = (ts: number) => {
		openTab(`/timeline/${Math.round(ts)}`, { title: "Timeline" });
		close();
	};

	const handleSelectChat = (id: string) => {
		setActiveConversationId(id);
		openTab("/chat", { conversationId: id });
		close();
	};

	const handleNavigate = (to: string, title?: string) => {
		openTab(to, title ? { title } : undefined);
		close();
	};

	// Run a plugin-contributed command from the palette: fire its `onCommand:<id>`
	// activation event so any onCommand-gated plugin wakes. Best-effort — the UX
	// (closing the palette) never blocks on the POST, and a failure is swallowed
	// (Core only validates the `onCommand:` prefix, so a no-op is harmless).
	const handleRunPluginCommand = (commandId: string, label: string) => {
		close();
		fireActivationEvent(target, commandId)
			.then(() => {
				toast.success(`Ran ${label}`);
			})
			.catch(() => {
				// Silent: activation is best-effort and must not disrupt the palette.
			});
	};

	const handleNewChat = () => {
		setActiveConversationId(null);
		openTab("/chat", { forceNew: true });
		close();
	};

	const handleImportThread = () => {
		close();
		setImportOpen(true);
	};

	const handleOpenSettings = (section: SettingsSection) => {
		setSettingsSection(section);
		setSettingsOpen(true);
		close();
	};

	const handleSignOutAction = () => {
		handleSignOut();
		close();
	};

	const isMac = navigator.platform.toLowerCase().includes("mac");
	const modKey = isMac ? "⌘" : "Ctrl";

	// Build the flat action list the shared palette renders. Same groups, values,
	// icons, shortcuts, and side effects as the previous inline cmdk markup. Built
	// directly in render (like the old inline markup) so it always reflects the
	// latest conversation list, theme, and sign-out state.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: assembles many independent, flat action groups (chats, nav, theme, account); splitting would scatter one cohesive list.
	const buildActions = (): CommandAction[] => {
		const conversations = listConversations().slice(0, MAX_CHAT_RESULTS);
		const items: CommandAction[] = [];

		for (const conv of conversations) {
			items.push({
				id: `chat-${conv.id}`,
				group: "Chats",
				title: conv.title,
				value: `chat ${conv.title} ${conv.id}`,
				trailing: conv.folderPath
					? conv.folderPath.split(PATH_SEPARATOR).pop()
					: undefined,
				onSelect: () => handleSelectChat(conv.id),
			});
		}

		items.push(
			{
				id: "theme-light",
				group: "Theme",
				title: "Light",
				value: "theme light",
				icon: Sun01Icon,
				checked: theme === "light",
				onSelect: () => {
					setTheme("light");
					close();
				},
			},
			{
				id: "theme-dark",
				group: "Theme",
				title: "Dark",
				value: "theme dark",
				icon: Moon01Icon,
				checked: theme === "dark",
				onSelect: () => {
					setTheme("dark");
					close();
				},
			},
			{
				id: "theme-system",
				group: "Theme",
				title: "System",
				value: "theme system",
				icon: ComputerIcon,
				checked: theme === "system",
				onSelect: () => {
					setTheme("system");
					close();
				},
			},
			{
				id: "appearance-settings",
				group: "Appearance",
				title: "Open Appearance Settings",
				value: "appearance settings",
				icon: Settings01Icon,
				onSelect: () => handleOpenSettings("appearance"),
			}
		);

		for (const { to, label, icon } of NAV_ITEMS) {
			items.push({
				id: `nav-${to}`,
				group: "Navigation",
				title: label,
				value: `navigate ${label}`,
				icon,
				onSelect: () => handleNavigate(to, label),
			});
		}

		// App-registered sidebar buttons (Home, Memory, …) — navigable entries from
		// the contributions feed, so the palette isn't a second hardcoded nav list.
		// Skip any whose target already appears in NAV_ITEMS to avoid a dupe row.
		const navTargets = new Set<string>(NAV_ITEMS.map((n) => n.to));
		for (const button of contributedButtons) {
			if (navTargets.has(button.target)) {
				continue;
			}
			items.push({
				id: `nav-contrib-${button.plugin}-${button.id}`,
				group: "Navigation",
				title: button.title,
				value: `navigate ${button.title}`,
				icon: ArrowRight01Icon,
				onSelect: () => handleNavigate(button.target, button.title),
			});
		}

		// App-registered sidebar sections' live items (meeting notes, canvas boards,
		// …), each searchable and grouped under its section name — so the palette
		// reaches an app's own lists without the shell knowing they exist.
		for (const section of contributedSectionItems) {
			const itemTarget = section.itemTarget;
			if (!itemTarget) {
				continue;
			}
			for (const row of section.items) {
				const route = renderTemplate(
					itemTarget,
					{ item: row.raw },
					{ uriEncode: true }
				);
				items.push({
					id: `section-${section.plugin}-${section.sectionId}-${row.item.id}`,
					group: section.title,
					title: row.item.title,
					value: `${section.title} ${row.item.title} ${row.item.subtitle ?? ""}`,
					icon: ArrowRight01Icon,
					onSelect: () => handleNavigate(route, row.item.title),
				});
			}
		}

		// Secondary destinations that aren't in the primary sidebar list but are
		// still real pages — surface them here so a first-time user can actually
		// find them from the command palette.
		items.push(
			{
				id: "nav-marketplace",
				group: "Navigation",
				title: "Marketplace",
				value: "navigate marketplace store buy licenses sell",
				icon: DollarCircleIcon,
				onSelect: () => handleNavigate("/marketplace"),
			},
			{
				id: "nav-apps",
				group: "Navigation",
				title: "Plugins",
				value: "navigate plugins apps installed",
				icon: Package01Icon,
				onSelect: () => handleNavigate("/apps"),
			},
			{
				id: "nav-extensions",
				group: "Navigation",
				title: "Extensions",
				value: "navigate extensions browser desktop add-ons",
				icon: PuzzleIcon,
				onSelect: () => handleNavigate("/extensions"),
			},
			{
				id: "nav-webhooks",
				group: "Navigation",
				title: "Webhooks",
				value: "navigate webhooks endpoints ingress public url triggers",
				icon: WebhookIcon,
				onSelect: () => handleNavigate("/webhooks"),
			}
		);

		// Companion surfaces contributed by enabled plugins — navigable entries
		// sourced live from GET /api/plugins/contributions (nothing hardcoded).
		for (const companion of pluginCompanions) {
			const label = companion.label || companion.name;
			items.push({
				id: `nav-companion-${companion.id}`,
				group: "Plugins",
				title: label,
				value: `plugin companion ${label} ${companion.name}`,
				icon: PuzzleIcon,
				onSelect: () => handleNavigate(pluginCompanionPath(companion.id)),
			});
		}

		// Slash/commands contributed by enabled plugins. Selecting one fires its
		// onCommand activation event so command-gated plugins wake.
		for (const command of pluginCommands) {
			const commandId = contribString(command, "id");
			if (!commandId) {
				continue;
			}
			const trigger = contribString(command, "command");
			const description = contribString(command, "description");
			const label = trigger ?? commandId;
			items.push({
				id: `plugin-command-${commandId}`,
				group: "Plugin Commands",
				title: label,
				value: `plugin command ${label} ${commandId} ${description ?? ""}`,
				icon: PuzzleIcon,
				trailing: description ? undefined : trigger,
				onSelect: () => handleRunPluginCommand(commandId, label),
			});
		}

		// Commands registered directly into the contribution registry (the seam the
		// plugin extension host #446 registers into). Merged in alongside — never
		// replacing — the built-in actions and the API-driven plugin commands above.
		// A non-reactive singleton read: nothing calls `registerCommand` until the
		// plugin host lands, so the list is static at render time (fine for PR-1).
		for (const entry of contributionRegistry.listCommands()) {
			items.push({
				id: `contribution-${entry.id}`,
				group: entry.group,
				title: entry.title,
				value: `${entry.title} ${entry.keywords ?? ""}`,
				shortcut: entry.shortcut,
				icon: PuzzleIcon,
				onSelect: () => {
					void entry.run();
					close();
				},
			});
		}

		// Channels and Identities live inside the Gateway dialog; Credits lives in
		// App Settings → Services. Open the relevant dialog at that section rather
		// than navigating to a (now-removed) route.
		items.push({
			id: "nav-channels",
			group: "Navigation",
			title: "Channels",
			value: "navigate channels telegram slack discord whatsapp bots",
			icon: BotIcon,
			onSelect: () => {
				openGateway("channels");
				close();
			},
		});

		items.push({
			id: "nav-identities",
			group: "Navigation",
			title: "Identities",
			value: "navigate identities logins credentials connections vault",
			icon: Key01Icon,
			onSelect: () => {
				openGateway("identities");
				close();
			},
		});

		items.push({
			id: "nav-credits",
			group: "Navigation",
			title: "Credits",
			value: "navigate credits wallet balance billing top up",
			icon: DollarCircleIcon,
			onSelect: () => handleOpenSettings("credits"),
		});

		items.push(
			{
				id: "action-new-chat",
				group: "Actions",
				title: "New Chat",
				value: "new chat",
				icon: Add01Icon,
				shortcut: `${modKey}N`,
				onSelect: handleNewChat,
			},
			{
				id: "action-import-thread",
				group: "Actions",
				title: "Import Thread",
				value:
					"import thread claude code codex history resume past conversation",
				icon: Download01Icon,
				onSelect: handleImportThread,
			},
			{
				id: "action-profile",
				group: "Actions",
				title: "Profile & Account",
				value: "settings profile account",
				icon: Settings01Icon,
				onSelect: () => handleOpenSettings("profile"),
			},
			{
				id: "action-memory",
				group: "Actions",
				title: "Memory",
				value: "settings memory long-term",
				icon: Settings01Icon,
				onSelect: () => handleOpenSettings("memory"),
			},
			{
				id: "action-settings",
				group: "Actions",
				title: "Settings",
				value: "settings open",
				icon: Settings01Icon,
				shortcut: `${modKey},`,
				onSelect: () => handleOpenSettings("appearance"),
			},
			{
				id: "action-sign-out",
				group: "Actions",
				title: "Sign Out",
				value: "sign out log out",
				icon: Logout01Icon,
				disabled: isSigningOut,
				onSelect: handleSignOutAction,
			}
		);

		// "Search everything" + "remember" — only when there is a real query.
		const q = query.trim();
		if (q.length >= 2) {
			for (const [i, r] of shadowResults.entries()) {
				const text =
					r.window_title ||
					r.snippet ||
					r.app_name ||
					humanizeCaptureKind(r.event_type);
				items.push({
					id: `shadow-${i}`,
					group: "Search Everything",
					title: text,
					value: `${q} ${text}`,
					trailing: r.app_name ?? undefined,
					onSelect: () => handleOpenCapture(r.ts),
				});
			}
			// Semantic message hits — jump straight to the conversation that
			// contains the matching message.
			for (const [i, hit] of messageResults.entries()) {
				const snippet =
					hit.content.length > 90
						? `${hit.content.slice(0, 90)}…`
						: hit.content;
				items.push({
					id: `message-${hit.messageId || i}`,
					group: "Messages",
					title: snippet,
					// Keep the query in `value` so the shared palette's own filter
					// never hides a semantic hit that lacks a literal substring match.
					value: `${q} message ${hit.messageId}`,
					trailing: hit.role === "user" ? "you" : "assistant",
					onSelect: () => handleSelectChat(hit.conversationId),
				});
			}
			// "Remember" is listed last so it's never the auto-highlighted default
			// Enter target for an unmatched query — pressing Enter on a stray search
			// should land on a real result, not silently create a junk memory.
			items.push({
				id: "remember-query",
				group: "Memory",
				title: `Remember "${q}"`,
				value: `remember ${q}`,
				icon: Add01Icon,
				onSelect: requestRemember,
			});
		}

		return items;
	};

	return (
		<>
			<SharedCommandPalette
				actions={buildActions()}
				onOpenChange={(o) => (o ? setOpen(true) : close())}
				onSearchChange={setQuery}
				open={open}
				placeholder="Search everything or run a command..."
				search={query}
			/>

			<SettingsDialog
				defaultSection={settingsSection}
				onOpenChange={setSettingsOpen}
				open={settingsOpen}
			/>

			<ImportThreadsDialog
				agents={agents}
				onImported={(conversationId) => {
					setActiveConversationId(conversationId);
					openTab("/chat", { conversationId });
				}}
				onOpenChange={setImportOpen}
				open={importOpen}
				target={target}
			/>

			<AlertDialog
				onOpenChange={(o) => {
					if (!o) {
						setPendingMemory(null);
					}
				}}
				open={pendingMemory !== null}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Save this to memory?</AlertDialogTitle>
						<AlertDialogDescription>
							{pendingMemory
								? `We'll remember "${pendingMemory}" so you can find it later.`
								: ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								confirmRemember();
							}}
						>
							Save
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}
