import {
	Add01Icon,
	ArrowRight01Icon,
	BrainIcon,
	Chat01Icon,
	ComputerIcon,
	DeliverySecure01Icon,
	DollarCircleIcon,
	Download01Icon,
	FingerPrintIcon,
	FullScreenIcon,
	LayerIcon,
	Logout01Icon,
	Moon01Icon,
	Package01Icon,
	PlugSocketIcon,
	PotionIcon,
	Settings01Icon,
	Settings02Icon,
	Sun01Icon,
	Target01Icon,
	Tv01Icon,
	WorkflowCircle06Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { renderTemplate } from "@ryu/app-host/views";
import { CommandPalette as SharedCommandPalette } from "@ryu/command/CommandPalette";
import type { CommandAction, CommandPaletteTab } from "@ryu/command/types";
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
import type { UnlistenFn } from "@tauri-apps/api/event";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthContext } from "@/contexts/auth-context.tsx";
import { ImportSetupDialog } from "@/src/components/chat/ImportSetupDialog.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import { contributionRegistry } from "@/src/contributions/registry.ts";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useCommandSearchSections } from "@/src/hooks/useCommandSearchSections.ts";
import { useContributedSectionItems } from "@/src/hooks/useContributedCommands.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type MessageSearchHit,
	searchConversations,
} from "@/src/lib/api/conversation-search.ts";
import {
	formatPricingLabel,
	type MarketplaceCard,
	searchMarketplaceCatalog,
} from "@/src/lib/api/marketplace.ts";
import { createMemory } from "@/src/lib/api/memory.ts";
import { fireActivationEvent } from "@/src/lib/api/plugins.ts";
import { type ShadowSearchResult, searchShadow } from "@/src/lib/api/shadow.ts";
import {
	type SpaceLexicalHit,
	searchSpaceDocuments,
} from "@/src/lib/api/spaces.ts";
import { toggleFullscreen } from "@/src/lib/fullscreen.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import { compactAge } from "@/src/lib/time.ts";
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
	| "usage"
	| "hardware"
	| "memory";

/**
 * The SHELL's own pages — the ones this desktop client compiles in and owns. A
 * Ryu App is deliberately NOT in this list: an app reaches the palette through
 * the contributions feed instead (its `companion` surface, its `sidebar_buttons`,
 * or its `sidebar_sections`' live items), exactly like it reaches the sidebar.
 *
 * Calendar / Timeline / Monitors / Tasks / Meetings / Learning used to sit here.
 * Each is an apps-store app (`com.ryu.{calendar,timeline,monitors,quests,
 * meetings,learning}`) that declares a `companion`, so it was already being
 * listed by the data-driven sidebar-section index — the hardcoded row was a second, dumber
 * copy that rendered whether or not the app was installed (all six are
 * not pre-installed) and pointed at a shell alias route rather than the seam route the
 * companion mints. Same reasoning, and the same fix, as the sidebar's
 * `CHROME_ORDER`: the App declares itself; the shell does not enumerate Apps.
 *
 * Inbox and Memory were the last two survivors of that rule. Approvals remains
 * opt-in, while Memory is pre-installed so its authenticated Library route is
 * reachable on a fresh install. Neither needs a row here: an enabled approvals
 * app is listed by the data-driven sidebar-section index, and the enabled Memory
 * app contributes a `sidebar_buttons` entry targeting `/library/memory` that the
 * contributed-button loop lists. Note the dedupe below reads `navTargets` — while a target sat in
 * NAV_ITEMS the shell's dumb copy actively SUPPRESSED the app's own declaration.
 */
const NAV_ITEMS = [
	{ to: "/chat", label: "Chat", icon: Chat01Icon },
	{ to: "/library/agent", label: "Agents", icon: Target01Icon },
	{ to: "/engines", label: "Engines", icon: LayerIcon },
	{ to: "/models", label: "Models", icon: BrainIcon },
	{ to: "/skills", label: "Skills", icon: PotionIcon },
	{ to: "/library/space", label: "Spaces", icon: DeliverySecure01Icon },
	{ to: "/tools", label: "Tools", icon: Wrench01Icon },
	{ to: "/library/workflow", label: "Workflows", icon: WorkflowCircle06Icon },
	{ to: "/review", label: "Weekly review", icon: ArrowRight01Icon },
] as const;

const NAV_RESULT_TYPES: Partial<Record<string, string>> = {
	"/chat": "chats",
	"/engines": "engines",
	"/library/agent": "agents",
	"/library/space": "spaces",
	"/library/workflow": "workflows",
	"/skills": "skills",
	"/tools": "tools",
};

const MAX_CHAT_RESULTS = 30;

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
	const [setupImportOpen, setSetupImportOpen] = useState(false);
	const [settingsSection, setSettingsSection] =
		useState<SettingsSection>("appearance");
	const [activeResultType, setActiveResultType] = useState("all");
	const { openTab, requestScrollToMessage } = useTabsContext();
	const { agents, sections: commandSearchSections } =
		useCommandSearchSections();
	const { theme, setTheme } = useTheme();
	const { setActiveConversationId } = useChatHistoryContext();
	const { handleSignOut, isSigningOut } = useAuthContext();
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	// Enabled plugins' declarative contributions (companions + slash commands +
	// app-registered sidebar buttons), shared via react-query cache with the
	// route-registration hook in Layout.
	const {
		slash_commands: pluginCommands,
		sidebar_buttons: contributedButtons,
		sidebar_sections: contributedSidebarSections,
	} = usePluginContributions();
	// Live items of every app-contributed sidebar section (meeting notes, canvas
	// boards, …), fetched only while the palette is open so they're searchable
	// here without the shell hardcoding a single list.
	const contributedSectionItems = useContributedSectionItems(open);
	const [query, setQuery] = useState("");
	const [pendingMemory, setPendingMemory] = useState<string | null>(null);
	const [shadowResults, setShadowResults] = useState<ShadowSearchResult[]>([]);
	const [messageResults, setMessageResults] = useState<MessageSearchHit[]>([]);
	const [spaceResults, setSpaceResults] = useState<SpaceLexicalHit[]>([]);
	const [marketplaceResults, setMarketplaceResults] = useState<
		MarketplaceCard[]
	>([]);
	const searchAbort = useRef<AbortController | null>(null);
	const messageAbort = useRef<AbortController | null>(null);
	const spaceAbort = useRef<AbortController | null>(null);
	const marketplaceAbort = useRef<AbortController | null>(null);

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
	//
	// `/timeline` is an app-owned path resolved through the companion-alias
	// catch-all, and the owning app is not pre-installed — so the tray item is gated on
	// the same live feed the route mounts from, and does nothing when no enabled
	// app claims it rather than opening an "App not enabled" tab. Same AFFORDANCE
	// rule the `nav.timeline` hotkey in `Layout.tsx` already follows.
	const timelineCompanion = useCompanionAlias("/timeline");
	useEffect(() => {
		// Routed through the ready-gate. This effect runs on the first render of the
		// shell, which on a cold start can beat Tauri's injection of
		// `window.__TAURI_INTERNALS__` — and a bare `listen()` then rejects reaching
		// for `transformCallback`, which is the most frequent production signature
		// (RUST-C, 66 events). The gate queues the subscribe until the bridge lands
		// and degrades to a no-op unlisten when there is no bridge at all.
		//
		// The `.catch` is attached at subscribe time, NOT only in the cleanup: the
		// palette stays mounted for the whole session, so its cleanup never runs on
		// the boot path, and a rejection parked on an un-terminated promise fires
		// `unhandledrejection` at the window before any later `.catch` could adopt it.
		let disposed = false;
		const unlisteners: UnlistenFn[] = [];
		const track = (unlisten: UnlistenFn) => {
			// Unmounted while the subscribe was still in flight — drop it immediately
			// rather than leaking a listener with no owner.
			if (disposed) {
				unlisten();
				return;
			}
			unlisteners.push(unlisten);
		};
		const ignore = (error: unknown) => {
			console.error("tray event subscription failed", error);
		};
		listenWhenReady("tray-open-timeline", () => {
			if (timelineCompanion) {
				openTab("/timeline");
			}
		})
			.then(track)
			.catch(ignore);
		listenWhenReady("tray-open-palette", () => setOpen(true))
			.then(track)
			.catch(ignore);
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
		};
		// `timelineCompanion` is a plain string|null, so this only re-subscribes
		// when the owning app is actually enabled or disabled.
	}, [openTab, timelineCompanion]);

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

	// Debounced exact + semantic search over past chat messages. Core puts lexical
	// FTS hits first and semantic hits after them, so literal recall stays
	// predictable without losing meaning-based matches when embeddings exist.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `target` is a fresh object every render; depending on its primitive fields avoids an infinite update loop (see comment on the deps array below).
	useEffect(() => {
		const q = query.trim();
		messageAbort.current?.abort();
		if (q.length < 2) {
			setMessageResults([]);
			return;
		}
		setMessageResults([]);
		const handle = setTimeout(async () => {
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

	// Page/Space lexical search is separate from per-Space RAG search: the palette
	// needs predictable literal recall over visible metadata, page source, and
	// extracted chunks, even when no embedding model is available.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `target` is a fresh object every render; primitive fields are the stable request identity.
	useEffect(() => {
		const q = query.trim();
		spaceAbort.current?.abort();
		if (q.length < 2) {
			setSpaceResults([]);
			return;
		}
		setSpaceResults([]);
		const handle = setTimeout(async () => {
			const controller = new AbortController();
			spaceAbort.current = controller;
			const results = await searchSpaceDocuments(
				target,
				q,
				8,
				controller.signal
			);
			if (results) {
				setSpaceResults(results);
			}
		}, 250);
		return () => clearTimeout(handle);
	}, [query, target.url, target.token]);

	// The control-plane Marketplace is a separate public catalog from the
	// node-scoped Store feed. Search it only after the user has typed a real query,
	// and keep failures isolated so an unavailable Marketplace never breaks local
	// commands, messages, pages, or captured context.
	useEffect(() => {
		const q = query.trim();
		marketplaceAbort.current?.abort();
		if (q.length < 2) {
			setMarketplaceResults([]);
			return;
		}
		setMarketplaceResults([]);
		const controller = new AbortController();
		marketplaceAbort.current = controller;
		const handle = setTimeout(() => {
			searchMarketplaceCatalog(q, 8, controller.signal)
				.then((results) => {
					if (!controller.signal.aborted) {
						setMarketplaceResults(results);
					}
				})
				.catch(() => {
					// Marketplace search is an optional palette lane.
				});
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query]);

	const close = () => {
		setOpen(false);
		setQuery("");
		setActiveResultType("all");
		setShadowResults([]);
		setMessageResults([]);
		setSpaceResults([]);
		setMarketplaceResults([]);
	};

	const searchTabs = useMemo<CommandPaletteTab[]>(
		() => [
			{ id: "all", label: "All" },
			{ id: "messages", label: "Messages", icon: Chat01Icon },
			{ id: "pages", label: "Pages", icon: DeliverySecure01Icon },
			{ id: "marketplace", label: "Marketplace", icon: Package01Icon },
			...commandSearchSections.map((section) => ({
				icon: section.icon,
				id: section.id,
				label: section.label,
			})),
			...contributedSidebarSections
				.slice()
				.sort(
					(a, b) =>
						(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
				)
				.map((section) => ({
					id: `plugin:${section.plugin}:${section.id}`,
					label: section.title,
					icon: PlugSocketIcon,
				})),
		],
		[commandSearchSections, contributedSidebarSections]
	);

	useEffect(() => {
		if (!searchTabs.some((tab) => tab.id === activeResultType)) {
			setActiveResultType("all");
		}
	}, [activeResultType, searchTabs]);

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
			await createMemory(target, { content });
			toast.success("Saved to memory", { description: content });
		} catch {
			toast.error("Couldn't save to memory", {
				description: "Please check your connection and try again.",
			});
		}
	};

	// Open a captured item back in the timeline at the moment it happened. The
	// timeline is now a sandboxed companion (@ryu/timeline); a shell window event
	// cannot cross the frame, so the timestamp rides the deep-link path (/timeline/:ts)
	// and the route bakes it into the frame's mount context as
	// `window.ryu.context.focusTs`, which the companion reads at mount to scrub
	// straight to that moment instead of dumping the user at "now".
	const handleOpenCapture = (ts: number) => {
		openTab(`/timeline/${Math.round(ts)}`, { title: "Timeline" });
		close();
	};

	const handleSelectChat = (id: string, messageId?: string) => {
		setActiveConversationId(id);
		openTab("/chat", { conversationId: id });
		if (messageId) {
			requestScrollToMessage(id, messageId);
		}
		close();
	};

	const handleSelectPage = (hit: SpaceLexicalHit) => {
		openTab(
			`/spaces/${encodeURIComponent(hit.spaceId)}/doc/${encodeURIComponent(hit.documentId)}`,
			{ title: hit.title }
		);
		close();
	};

	const handleSelectMarketplace = (
		card: MarketplaceCard,
		queryText: string
	) => {
		openTab("/marketplace", {
			initialStoreItem: { id: card.id, kind: card.kind },
			initialStoreQuery: queryText,
		});
		close();
	};

	// `to` may be a CONTRIBUTED target, whose allowlisted query parameters belong in
	// openTab's options rather than its path (a conversation has no route of its
	// own). Plain built-in paths carry no query and pass through unchanged.
	const handleNavigate = (to: string, title?: string) => {
		const { path, options } = parseContributedTarget(to);
		openTab(path, { ...options, ...(title ? { title } : {}) });
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

	const handleImportSetup = () => {
		close();
		setSetupImportOpen(true);
	};

	const handleToggleFullscreen = () => {
		close();
		toggleFullscreen().catch(() => {
			toast.error("Couldn't toggle full screen in this window.");
		});
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
	const formatAgeAgo = (timestamp?: number): string | undefined => {
		if (!(timestamp && Number.isFinite(timestamp))) {
			return undefined;
		}
		const age = compactAge(timestamp);
		return age === "now" ? "just now" : `${age} ago`;
	};
	const resultMeta = (
		subtitle: string | null | undefined,
		timestamp?: number
	): string | undefined =>
		[subtitle, formatAgeAgo(timestamp)].filter(Boolean).join(" · ") ||
		undefined;

	// Build the flat action list the shared palette renders. Same groups, values,
	// icons, shortcuts, and side effects as the previous inline cmdk markup. Built
	// directly in render (like the old inline markup) so it always reflects the
	// latest conversation list, theme, and sign-out state.
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: assembles many independent, flat action groups (chats, nav, theme, account); splitting would scatter one cohesive list.
	const buildActions = (): CommandAction[] => {
		const items: CommandAction[] = [];

		// Every built-in sidebar section contributes its live rows to the same flat
		// action list. The section id is the filter id, so adding a sidebar section
		// only requires extending the shared section registry/data source.
		for (const section of commandSearchSections) {
			const rows =
				section.id === "chats"
					? section.items.slice(0, MAX_CHAT_RESULTS)
					: section.items;
			for (const row of rows) {
				items.push({
					id: `sidebar-${section.id}-${row.id}`,
					group: section.label,
					title: row.title,
					value: `${section.label} ${row.title} ${row.subtitle ?? ""}`,
					resultType: section.id,
					trailing: resultMeta(row.subtitle, row.timestamp),
					icon: row.icon ?? section.icon,
					onSelect: () => {
						row.onSelect();
						close();
					},
				});
			}
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
			const resultType = NAV_RESULT_TYPES[to];
			if (resultType && !searchTabs.some((tab) => tab.id === resultType)) {
				continue;
			}
			items.push({
				id: `nav-${to}`,
				group: "Navigation",
				title: label,
				value: `navigate ${label}`,
				icon,
				resultType,
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
					resultType: `plugin:${section.plugin}:${section.sectionId}`,
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
				icon: PlugSocketIcon,
				onSelect: () => handleNavigate("/extensions"),
			}
			// "Webhooks" used to be a fourth row here. `/webhooks` is owned by the
			// `@ryu/webhooks` app, which declares a companion — so the section index
			// already lists it, live, exactly when the app is enabled. The hardcoded
			// row was the same mistake NAV_ITEMS' comment describes (it rendered on a
			// fresh install, where the app is off, and led to "App not enabled"), and
			// worse: sitting in a hardcoded list put it in `navTargets`, whose dedupe
			// then SUPPRESSED the app's own declaration. Deleting it is what makes
			// the real entry appear.
		);

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
				icon: PlugSocketIcon,
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
				icon: PlugSocketIcon,
				onSelect: () => {
					void entry.run();
					close();
				},
			});
		}

		// Channels and Identities are Library collections with dedicated manage
		// pages. Credits lives in App Settings → Services.
		items.push({
			id: "nav-channels",
			group: "Navigation",
			title: "Channels",
			value:
				"navigate channels telegram slack whatsapp personal business cloud api discord bots",
			icon: Tv01Icon,
			resultType: "channels",
			onSelect: () => handleNavigate("/library/channel", "Channels"),
		});

		items.push({
			id: "nav-identities",
			group: "Navigation",
			title: "Identities",
			value: "navigate identities logins credentials connections vault",
			icon: FingerPrintIcon,
			resultType: "identities",
			onSelect: () => handleNavigate("/library/identity", "Identities"),
		});

		items.push({
			id: "nav-credits",
			group: "Navigation",
			title: "Credits",
			value: "navigate credits wallet balance billing top up",
			icon: DollarCircleIcon,
			onSelect: () => handleOpenSettings("credits"),
		});

		items.push({
			id: "nav-usage",
			group: "Navigation",
			title: "Usage",
			// The words someone actually types when a charge surprises them, which
			// are rarely the word "usage".
			value:
				"navigate usage statement spend history transactions what did i spend charges cost",
			icon: DollarCircleIcon,
			onSelect: () => handleOpenSettings("usage"),
		});

		items.push(
			{
				id: "action-new-chat",
				group: "Actions",
				title: "New Chat",
				value: "new chat",
				resultType: "chats",
				icon: Add01Icon,
				shortcut: `${modKey}N`,
				onSelect: handleNewChat,
			},
			{
				id: "action-toggle-fullscreen",
				group: "Actions",
				title: "Toggle Full Screen",
				value: "fullscreen full screen maximize window presentation f11",
				icon: FullScreenIcon,
				shortcut: "F11",
				onSelect: handleToggleFullscreen,
			},
			{
				id: "action-import-thread",
				group: "Actions",
				title: "Import Thread",
				value:
					"import thread claude code codex history resume past conversation",
				resultType: "chats",
				icon: Download01Icon,
				onSelect: handleImportThread,
			},
			{
				id: "action-import-setup",
				group: "Actions",
				title: "Import Agent Setup",
				value:
					"import setup instructions skills mcp server plugin memory claude cursor codex from folder",
				icon: Settings02Icon,
				onSelect: handleImportSetup,
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
				shortcut: `${modKey}.`,
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
			// Exact + semantic message hits — jump straight to the conversation that
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
					resultType: "messages",
					trailing: `${hit.role === "user" ? "you" : "assistant"} · ${formatAgeAgo(hit.createdAt) ?? "just now"}`,
					onSelect: () => handleSelectChat(hit.conversationId, hit.messageId),
				});
			}
			for (const [i, hit] of spaceResults.entries()) {
				items.push({
					id: `page-${hit.documentId || i}`,
					group: "Pages",
					title: hit.title,
					value: `${q} page ${hit.title} ${hit.spaceName} ${hit.snippet}`,
					resultType: "pages",
					trailing: resultMeta(hit.spaceName, hit.updatedAt),
					icon: DeliverySecure01Icon,
					onSelect: () => handleSelectPage(hit),
				});
			}
			for (const card of marketplaceResults) {
				items.push({
					id: `marketplace-${card.kind}-${card.id}`,
					group: "Marketplace",
					title: card.name,
					value: `${q} marketplace ${card.kind} ${card.id} ${card.description ?? ""} ${card.author ?? ""}`,
					resultType: "marketplace",
					trailing: card.pricing ? formatPricingLabel(card.pricing) : card.kind,
					icon: Package01Icon,
					onSelect: () => handleSelectMarketplace(card, q),
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
				activeTab={activeResultType}
				onOpenChange={(o) => (o ? setOpen(true) : close())}
				onSearchChange={setQuery}
				onTabChange={setActiveResultType}
				open={open}
				placeholder="Search everything or run a command..."
				search={query}
				tabs={searchTabs}
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

			<ImportSetupDialog
				onOpenChange={setSetupImportOpen}
				open={setupImportOpen}
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
