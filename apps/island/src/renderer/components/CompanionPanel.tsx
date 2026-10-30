// The expanded island's companion surface: a tab strip over the mini chat and any
// enabled Ryu App (Companion) that carries a UI bundle. When no companion apps are
// enabled the strip is absent and this renders the chat exactly as before, so the
// default island UX is unchanged.
//
// Each companion tab mounts `IslandPluginHost`, which renders the plugin's bundled
// UI in `@ryu/app-host`'s sandboxed iframe. The iframe is `h-full`, so a companion
// tab needs a height-bounded parent AND the tall expanded surface — this component
// forces `expandedTall` while a companion is active (so the expanded panel takes its
// full fixed height) and fills that height like the chat does, giving the frame real
// bounds; switching back to chat hands height control back to the chat (which sizes
// to its own history).

import { AnimatePresence } from "motion/react";
import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import type { PluginView } from "../../shared/ipc.ts";
import { usePluginContributions } from "../hooks/use-plugin-contributions.ts";
import { IslandPluginHost } from "../host/IslandPluginHost.tsx";
import { useIslandState } from "../store/island-state.ts";
import { ContributedView } from "./ContributedView.tsx";
import { IslandChat } from "./chat/IslandChat.tsx";
import { IslandMorphingPage } from "./IslandMorphingPage.tsx";

/** The chat tab's sentinel id (companion ids never collide — they are `app__…`). */
const CHAT_TAB = "chat";

/** The tab id for a contributed declarative view. Scoped by the owning plugin so two
 *  apps can reuse a view id, and prefixed so it never collides with a companion id
 *  (`app__…`) or the chat sentinel. */
function viewTabId(view: PluginView): string {
	return `view__${view.plugin}__${view.id}`;
}

/** Arrow keys, Home and End move between tabs (and select them) in the strip. */
function onTabListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
	const tabs = [
		...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
	];
	const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
	if (current < 0) {
		return;
	}
	let next: number | null = null;
	if (event.key === "ArrowRight") {
		next = (current + 1) % tabs.length;
	} else if (event.key === "ArrowLeft") {
		next = (current - 1 + tabs.length) % tabs.length;
	} else if (event.key === "Home") {
		next = 0;
	} else if (event.key === "End") {
		next = tabs.length - 1;
	}
	if (next === null) {
		return;
	}
	event.preventDefault();
	tabs[next]?.focus();
	tabs[next]?.click();
}

export function CompanionPanel() {
	const { companions, views } = usePluginContributions();
	// Only companions that actually carry a runnable UI are tabbable.
	const uiCompanions = useMemo(
		() => companions.filter((c) => c.hasUi),
		[companions]
	);
	// Only views with a renderable spec and a known owning plugin (the tab key needs
	// it) are tabbable — mirrors the desktop `usePluginContributionRoutes` filter.
	const renderableViews = useMemo(
		() =>
			views.filter(
				(v) => v.spec != null && v.plugin !== undefined && v.plugin.length > 0
			),
		[views]
	);
	const [active, setActive] = useState<string>(CHAT_TAB);
	const setExpandedTall = useIslandState((store) => store.setExpandedTall);

	// A selected companion or view is opened tall; the chat tab hands height control
	// back to `IslandChat` (which sets `expandedTall` from its own history on mount).
	const nonChatActive = active !== CHAT_TAB;
	useEffect(() => {
		if (nonChatActive) {
			setExpandedTall(true);
		}
	}, [nonChatActive, setExpandedTall]);

	// A companion or view can be uninstalled/disabled out from under the active tab;
	// fall back to chat when the selected surface is no longer present.
	useEffect(() => {
		if (
			active !== CHAT_TAB &&
			!uiCompanions.some((c) => c.id === active) &&
			!renderableViews.some((v) => viewTabId(v) === active)
		) {
			setActive(CHAT_TAB);
		}
	}, [active, uiCompanions, renderableViews]);
	useEffect(() => window.island.plugins.onShortcut(setActive), []);

	// No companion apps and no declarative views: render the chat exactly as before
	// (no tab chrome), so the default island UX is unchanged.
	if (uiCompanions.length === 0 && renderableViews.length === 0) {
		return <IslandChat />;
	}

	const activeCompanion = uiCompanions.find((c) => c.id === active) ?? null;
	const activeView =
		renderableViews.find((v) => viewTabId(v) === active) ?? null;

	return (
		<div className="flex h-full w-full flex-col gap-2">
			<div
				aria-label="Island pages"
				className="flex shrink-0 items-center gap-1 overflow-x-auto"
				onKeyDown={onTabListKeyDown}
				role="tablist"
			>
				<TabButton
					active={active === CHAT_TAB}
					label="Chat"
					onSelect={() => setActive(CHAT_TAB)}
				/>
				{uiCompanions.map((companion) => (
					<TabButton
						active={active === companion.id}
						key={companion.id}
						label={companion.label || companion.name}
						onSelect={() => setActive(companion.id)}
					/>
				))}
				{renderableViews.map((view) => (
					<TabButton
						active={active === viewTabId(view)}
						key={viewTabId(view)}
						label={view.title || view.id}
						onSelect={() => setActive(viewTabId(view))}
					/>
				))}
			</div>
			<div className="min-h-0 flex-1">
				<AnimatePresence initial={false} mode="popLayout">
					{activeCompanion ? (
						// Keep app pages in the same glass shell; the panel height and page
						// contents morph together as the selected tab changes.
						<IslandMorphingPage
							className="h-full w-full overflow-hidden rounded-lg"
							key={active}
						>
							<IslandPluginHost
								companion={activeCompanion}
								key={`${activeCompanion.pluginId}:${activeCompanion.id}:${activeCompanion.coreGeneration}`}
							/>
						</IslandMorphingPage>
					) : activeView ? (
						<IslandMorphingPage
							className="h-full w-full overflow-y-auto"
							key={active}
						>
							<ContributedView view={activeView} />
						</IslandMorphingPage>
					) : (
						<IslandMorphingPage className="w-full" key={CHAT_TAB}>
							<IslandChat />
						</IslandMorphingPage>
					)}
				</AnimatePresence>
			</div>
		</div>
	);
}

function TabButton({
	active,
	label,
	onSelect,
}: {
	active: boolean;
	label: string;
	onSelect: () => void;
}) {
	return (
		<button
			aria-selected={active}
			// The Island surface is the popover token, which equals `muted`, so the
			// selected and hover fills tint the foreground like the menu primitive.
			className={`flex h-8 shrink-0 items-center rounded-lg px-2 text-sm outline-none transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring ${
				active
					? "bg-foreground/10 text-foreground"
					: "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
			}`}
			onClick={onSelect}
			role="tab"
			tabIndex={active ? 0 : -1}
			type="button"
		>
			{label}
		</button>
	);
}
