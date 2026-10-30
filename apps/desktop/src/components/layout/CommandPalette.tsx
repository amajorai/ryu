import {
	Chat01Icon,
	DeliverySecure01Icon,
	Package01Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { COMPUTE_SHARE_FLAG } from "@ryu/auth/lib/feature-flags";
import {
	type AttachedImage,
	InputBar,
} from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { CommandPalette as SharedCommandPalette } from "@ryu/command/CommandPalette";
import type { CommandAction, CommandPaletteTab } from "@ryu/command/types";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useTheme } from "next-themes";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuthContext } from "@/contexts/auth-context.tsx";
import { ImportSetupDialog } from "@/src/components/chat/ImportSetupDialog.tsx";
import { ImportThreadsDialog } from "@/src/components/chat/ImportThreadsDialog.tsx";
import { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { useTabSelector } from "@/src/contexts/TabsContext.tsx";
import { parseContributedTarget } from "@/src/contributions/contributed-target.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import { useCommandSearchSections } from "@/src/hooks/useCommandSearchSections.ts";
import { useContributedSectionItems } from "@/src/hooks/useContributedCommands.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { MarketplaceCard } from "@/src/lib/api/marketplace.ts";
import { createMemory } from "@/src/lib/api/memory.ts";
import { fireActivationEvent } from "@/src/lib/api/plugins.ts";
import type { SpaceLexicalHit } from "@/src/lib/api/spaces.ts";
import { toggleFullscreen } from "@/src/lib/fullscreen.ts";
import { prefetchRoute } from "@/src/lib/route-prefetch.ts";
import { useSettingsDialog } from "@/src/store/useSettingsDialog.ts";
import { useOptionalDesktopWorkbench } from "@/src/workbench/DesktopWorkbenchContext.tsx";
import { useWorkbenchToolsContext } from "@/src/workbench/workbench-chrome.tsx";
import { buildCommandPaletteActions } from "./CommandPalette-actions.ts";
import { attachComposeImages } from "./CommandPalette-compose.ts";
import type { SettingsSection } from "./CommandPalette-nav-items.ts";
import { useCommandPaletteOpenTriggers } from "./CommandPalette-open-triggers.ts";
import { CommandPaletteRememberDialog } from "./CommandPalette-remember-dialog.tsx";
import { useCommandPaletteSearch } from "./CommandPalette-search.ts";

export function CommandPalette({
	defaultOpen = false,
}: {
	/** Open on mount: the shell loads the palette lazily on the first ⌘K. */
	defaultOpen?: boolean;
} = {}) {
	const [open, setOpen] = useState(defaultOpen);
	const openSettings = useSettingsDialog((s) => s.openSettings);
	const [importOpen, setImportOpen] = useState(false);
	const [setupImportOpen, setSetupImportOpen] = useState(false);
	const [activeResultType, setActiveResultType] = useState("all");
	const computeShareEnabled = useFeatureFlag(COMPUTE_SHARE_FLAG);
	const openTab = useTabSelector((state) => state.openTab);
	const requestScrollToMessage = useTabSelector(
		(state) => state.requestScrollToMessage
	);
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
	const targetScope = JSON.stringify([
		target.url,
		target.token,
		target.userJwt,
	]);
	const currentTargetScope = useRef({ scope: targetScope, generation: 0 });
	if (currentTargetScope.current.scope !== targetScope) {
		currentTargetScope.current = {
			scope: targetScope,
			generation: currentTargetScope.current.generation + 1,
		};
	}
	const targetGeneration = currentTargetScope.current.generation;
	const mounted = useRef(true);
	const composeGeneration = useRef(0);
	const isCurrentTarget = () =>
		mounted.current &&
		currentTargetScope.current.generation === targetGeneration;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			composeGeneration.current += 1;
		};
	}, []);
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
	const [composeDraft, setComposeDraft] = useState("");
	const [composeImages, setComposeImages] = useState<AttachedImage[]>([]);
	const [pendingMemory, setPendingMemory] = useState<string | null>(null);
	useEffect(() => {
		composeGeneration.current += 1;
		setComposeImages([]);
		setPendingMemory(null);
	}, [targetScope]);
	useCommandPaletteOpenTriggers(setOpen, openTab);
	const {
		marketplaceResults,
		messageResults,
		setMarketplaceResults,
		setMessageResults,
		setShadowResults,
		setSpaceResults,
		shadowResults,
		spaceResults,
	} = useCommandPaletteSearch(query, target, isCurrentTarget);

	const close = () => {
		composeGeneration.current += 1;
		setOpen(false);
		setQuery("");
		setComposeDraft("");
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
			if (!isCurrentTarget()) {
				return;
			}
			toast.success("Saved to memory", { description: content });
		} catch {
			if (!isCurrentTarget()) {
				return;
			}
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
		openTab(path, { ...options, ...(title ? { title } : undefined) });
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
				if (isCurrentTarget()) {
					toast.success(`Ran ${label}`);
				}
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
	const handleComposeAttach = () => {
		attachComposeImages({
			composeGeneration,
			isCurrentTarget,
			setComposeImages,
			target,
		});
	};

	const handleComposeSend = (content: string) => {
		const prompt = content.trim();
		if (!prompt && composeImages.length === 0) {
			return;
		}
		setActiveConversationId(null);
		openTab("/chat", {
			forceNew: true,
			initialPrompt: prompt || undefined,
			initialSubmit: true,
			initialImages: composeImages.length > 0 ? composeImages : undefined,
		});
		setComposeDraft("");
		setComposeImages([]);
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
		// One App Settings dialog per window, owned by the shell and driven by
		// the store; the palette only asks for a section.
		openSettings(section);
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
	// assembles many independent, flat action groups (chats, nav, theme, account); splitting would scatter one cohesive list.
	const workbench = useOptionalDesktopWorkbench();
	const workbenchTools = useWorkbenchToolsContext();
	const buildActions = (): CommandAction[] =>
		buildCommandPaletteActions({
			close,
			commandSearchSections,
			computeShareEnabled,
			contributedButtons,
			contributedSectionItems,
			handleImportSetup,
			handleImportThread,
			handleNavigate,
			handleNewChat,
			handleOpenCapture,
			handleOpenSettings,
			handleRunPluginCommand,
			handleSelectChat,
			handleSelectMarketplace,
			handleSelectPage,
			handleSignOutAction,
			handleToggleFullscreen,
			isSigningOut,
			marketplaceResults,
			messageResults,
			modKey,
			pluginCommands,
			query,
			requestRemember,
			searchTabs,
			setTheme,
			shadowResults,
			spaceResults,
			theme,
			workbench,
			workbenchTools,
		});

	return (
		<>
			<SharedCommandPalette
				actions={buildActions()}
				activeTab={activeResultType}
				composeContent={
					<InputBar
						attachedImages={composeImages}
						autoFocus
						className="pt-2"
						leftActions={
							<span
								className="flex items-center gap-2 px-2 text-muted-foreground text-xs"
								data-testid="compose-send-shortcut"
							>
								Send
								<Kbd>Enter</Kbd>
							</span>
						}
						onAttach={handleComposeAttach}
						onChange={setComposeDraft}
						onRemoveImage={(id) =>
							setComposeImages((previous) =>
								previous.filter((image) => image.id !== id)
							)
						}
						onSend={({ content }) => handleComposeSend(content)}
						onStop={() => undefined}
						placeholder="Write a message…"
						status="ready"
						value={composeDraft}
					/>
				}
				dialogLayout="expanded"
				onHighlight={(action) => {
					if (action.prefetchPath) {
						prefetchRoute(action.prefetchPath);
					}
				}}
				onOpenChange={(o) => (o ? setOpen(true) : close())}
				onSearchChange={setQuery}
				onTabChange={setActiveResultType}
				open={open}
				placeholder="Search everything or run a command…"
				search={query}
				tabs={searchTabs}
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

			<CommandPaletteRememberDialog
				confirmRemember={confirmRemember}
				pendingMemory={pendingMemory}
				setPendingMemory={setPendingMemory}
			/>
		</>
	);
}
