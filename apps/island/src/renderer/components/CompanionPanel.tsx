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

import { useEffect, useState } from "react";
import type { PluginView } from "../../shared/ipc.ts";
import { usePluginContributions } from "../hooks/use-plugin-contributions.ts";
import { IslandPluginHost } from "../host/IslandPluginHost.tsx";
import { useIslandState } from "../store/island-state.ts";
import { ContributedView } from "./ContributedView.tsx";
import { IslandChat } from "./chat/IslandChat.tsx";

/** The chat tab's sentinel id (companion ids never collide — they are `app__…`). */
const CHAT_TAB = "chat";

/** The tab id for a contributed declarative view. Scoped by the owning plugin so two
 *  apps can reuse a view id, and prefixed so it never collides with a companion id
 *  (`app__…`) or the chat sentinel. */
function viewTabId(view: PluginView): string {
	return `view__${view.plugin}__${view.id}`;
}

export function CompanionPanel() {
	const { companions, views } = usePluginContributions();
	// Only companions that actually carry a runnable UI are tabbable.
	const uiCompanions = companions.filter((c) => c.hasUi);
	// Only views with a renderable spec and a known owning plugin (the tab key needs
	// it) are tabbable — mirrors the desktop `usePluginContributionRoutes` filter.
	const renderableViews = views.filter(
		(v) => v.spec != null && typeof v.plugin === "string" && v.plugin.length > 0
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
			<div className="flex shrink-0 items-center gap-1 overflow-x-auto">
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
				{activeCompanion ? (
					// Fill the height-bounded expanded panel (like IslandChat does) so the
					// host's `h-full` iframe has real bounds instead of collapsing to 0.
					<div className="h-full w-full overflow-hidden rounded-lg border border-white/10">
						<IslandPluginHost companion={activeCompanion} />
					</div>
				) : activeView ? (
					// Host-rendered: the app returned DATA (a `ViewSpec`), the island owns
					// the pixels. `ContributedView` adds the privileged seams — source
					// fetch + live actions over the main-process Core client / host bridge.
					<div className="h-full w-full overflow-y-auto">
						<ContributedView view={activeView} />
					</div>
				) : (
					<IslandChat />
				)}
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
			aria-pressed={active}
			className={`shrink-0 rounded-full border px-2.5 py-0.5 font-medium text-[11px] transition-colors ${
				active
					? "border-indigo-400/40 bg-indigo-500/20 text-indigo-200"
					: "border-white/10 text-neutral-400 hover:bg-white/10 hover:text-neutral-200"
			}`}
			onClick={onSelect}
			type="button"
		>
			{label}
		</button>
	);
}
