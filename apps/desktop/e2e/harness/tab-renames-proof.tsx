import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { GroupHeaderPill } from "../../src/components/layout/TitleBar.tsx";
import { TabDndProvider } from "../../src/components/layout/tabDnd.tsx";
import { SplitPresetSettings } from "../../src/components/settings/SplitPresetSettings.tsx";
import type {
	Tab,
	TabGroup,
	TabsContextValue,
} from "../../src/contexts/TabsContext.tsx";
import { TabsContext } from "../../src/contexts/TabsContext.tsx";
import {
	makePresetBranch,
	makeSlot,
	type SplitPreset,
} from "../../src/lib/splitPresets.ts";
import {
	SPLIT_PRESETS_KEY,
	useSplitPresetStore,
} from "../../src/store/useSplitPresetStore.ts";
import "../../src/index.css";

const GROUP_ID = "group-research";
const GROUP_TAB: Tab = {
	groupId: GROUP_ID,
	id: "tab-research",
	path: "/chat",
	title: "Research thread",
};

const GROUP: TabGroup = {
	collapsed: false,
	color: "blue",
	id: GROUP_ID,
	name: "Research",
};

const PRESET: SplitPreset = {
	createdAt: 1,
	id: "preset-proof",
	name: "Editorial layout",
	root: makePresetBranch("columns", [makeSlot(), makeSlot()]),
};

localStorage.setItem(SPLIT_PRESETS_KEY, JSON.stringify([PRESET]));
useSplitPresetStore.getState().reload();

function Story() {
	const [group, setGroup] = useState(GROUP);
	const contextValue = useMemo(
		() =>
			({
				activeTabId: GROUP_TAB.id,
				closeGroup: () => undefined,
				groups: [group],
				moveTab: () => undefined,
				removeFromSplit: () => undefined,
				renameGroup: (_id: string, name: string) =>
					setGroup((current) => ({ ...current, name })),
				setGroupColor: (_id: string, color: TabGroup["color"]) =>
					setGroup((current) => ({ ...current, color })),
				splits: [],
				tabs: [GROUP_TAB],
				toggleGroupCollapsed: (id: string) => {
					if (id === GROUP_ID) {
						setGroup((current) => ({
							...current,
							collapsed: !current.collapsed,
						}));
					}
				},
				ungroup: () => undefined,
			}) as unknown as TabsContextValue,
		[group]
	);

	return (
		<TooltipProvider>
			<TabsContext.Provider value={contextValue}>
				<TabDndProvider>
					<main className="min-h-screen bg-background p-6 text-foreground">
						<header className="mx-auto mb-6 max-w-3xl">
							<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
								Desktop interaction proof
							</p>
							<h1 className="mt-1 font-semibold text-2xl">Inline renames</h1>
							<p className="mt-2 text-muted-foreground text-sm">
								Double-click each existing label to open its inline editor, then
								press Enter to commit the name.
							</p>
						</header>
						<div className="mx-auto grid max-w-3xl gap-6 lg:grid-cols-2">
							<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
								<p className="font-medium text-[10px] text-muted-foreground uppercase tracking-[0.16em]">
									Tab group
								</p>
								<div className="mt-4 flex items-center gap-3">
									<GroupHeaderPill group={group} />
									<output
										className="text-muted-foreground text-xs"
										data-testid="group-name"
									>
										{group.name}
									</output>
								</div>
							</section>
							<section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
								<SplitPresetSettings />
							</section>
						</div>
					</main>
				</TabDndProvider>
			</TabsContext.Provider>
		</TooltipProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
