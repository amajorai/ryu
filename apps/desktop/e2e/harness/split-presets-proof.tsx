import { I18nProvider } from "@ryu/i18n/react";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import { I18nDirectionProvider } from "@ryu/ui/components/direction.tsx";
import { TooltipProvider } from "@ryu/ui/components/tooltip.tsx";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	SaveSplitPresetDialog,
	SplitPresetMenuItems,
} from "@/src/components/layout/SplitPresetMenu.tsx";
import type { Split, Tab } from "@/src/contexts/TabsContext.tsx";
import { TabsContext } from "@/src/contexts/TabsContext.tsx";
import {
	buildPresetTree,
	PANE_CHOOSER_PATH,
	type PresetBranch,
	presetSlots,
	presetSummary,
} from "@/src/lib/splitPresets.ts";
import {
	equalizeNode,
	leafOrder,
	makeBranch,
	makeLeaf,
	type SplitBranch,
} from "@/src/lib/splitTree.ts";
import { createTabsProofContext } from "./tabs-proof-context.ts";
import "../../src/index.css";

const initialTabs: Tab[] = [
	{
		id: "pane-a",
		path: "/chat",
		title: "Research chat",
		splitId: "proof-split",
	},
	{
		id: "pane-b",
		path: "/marketplace",
		title: "Marketplace",
		splitId: "proof-split",
	},
];

function getActiveSplit(splits: Split[], activeSplitId: string): Split {
	const split = splits.find((candidate) => candidate.id === activeSplitId);
	if (!split) {
		throw new Error("The active proof split is missing.");
	}
	return split;
}

function equalizeProofBranch(root: SplitBranch): SplitBranch {
	const equalized = equalizeNode(root);
	if (equalized.type !== "branch") {
		throw new Error("Equalizing a split must preserve its branch root.");
	}
	return equalized;
}

function SplitPresetsProof() {
	const [tabs, setTabs] = useState<Tab[]>(initialTabs);
	const [splits, setSplits] = useState<Split[]>([
		{
			collapsed: false,
			color: "blue",
			id: "proof-split",
			name: "Research split",
			root: makeBranch(
				"columns",
				[makeLeaf("pane-a"), makeLeaf("pane-b")],
				[0.7, 0.3]
			),
		},
	]);
	const [activeSplitId, setActiveSplitId] = useState("proof-split");
	const [applyResult, setApplyResult] = useState("No preset applied");
	const split = getActiveSplit(splits, activeSplitId);
	const contextValue = useMemo(
		() =>
			createTabsProofContext({
				applySplitPreset: (presetRoot: PresetBranch, tabIds: string[]) => {
					const applied = buildPresetTree(presetRoot, tabIds);
					if (applied) {
						setSplits((current) =>
							current.map((candidate) =>
								candidate.id === activeSplitId
									? { ...candidate, root: applied }
									: candidate
							)
						);
						setApplyResult(`Existing panes: ${applied.orientation}`);
					}
				},
				applySplitPresetToNewTabs: (presetRoot: PresetBranch) => {
					const slots = presetSlots(presetRoot);
					const newSplitId = `preset-split-${splits.length}`;
					const newTabs: Tab[] = slots.map((slot, index) => {
						const path = slot.path ?? PANE_CHOOSER_PATH;
						return {
							id: `${newSplitId}-pane-${index + 1}`,
							path,
							title: slot.path ?? "Choose a page",
							splitId: newSplitId,
						};
					});
					const applied = buildPresetTree(
						presetRoot,
						newTabs.map((tab) => tab.id)
					);
					if (!applied) {
						return;
					}
					setTabs((current) => [...current, ...newTabs]);
					setSplits((current) => [
						...current,
						{
							collapsed: false,
							color: "blue",
							id: newSplitId,
							name: "Applied preset",
							root: applied,
						},
					]);
					setActiveSplitId(newSplitId);
					setApplyResult(
						`New panes: ${presetSummary({
							createdAt: 0,
							id: newSplitId,
							name: "Applied layout",
							root: presetRoot,
						})}`
					);
				},
				equalizeSplit: (splitId: string) =>
					setSplits((current) =>
						current.map((candidate) =>
							candidate.id === splitId
								? {
										...candidate,
										root: equalizeProofBranch(candidate.root),
									}
								: candidate
						)
					),
				splits,
				tabs,
			}),
		[activeSplitId, splits, tabs]
	);

	return (
		<I18nProvider>
			<I18nDirectionProvider>
				<TooltipProvider>
					<TabsContext.Provider value={contextValue}>
						<main className="dark min-h-screen bg-background p-8 text-foreground">
							<div className="mx-auto max-w-3xl space-y-5">
								<header>
									<p className="text-muted-foreground text-xs uppercase tracking-widest">
										Desktop interaction proof
									</p>
									<h1 className="font-semibold text-2xl">
										Pane layout presets
									</h1>
								</header>
								<section className="rounded-xl border border-border bg-card p-5">
									<p className="font-medium">Current split</p>
									<output data-testid="split-orientation">
										{split.root.orientation}
									</output>
									<output className="ml-3" data-testid="split-sizes">
										{split.root.sizes.join(",")}
									</output>
									<output className="ml-3" data-testid="pane-order">
										{leafOrder(split.root).join(",")}
									</output>
									<output className="ml-3" data-testid="pane-count">
										{leafOrder(split.root).length}
									</output>
									<output className="ml-3" data-testid="split-count">
										{splits.length}
									</output>
									<output className="ml-3" data-testid="active-split-id">
										{split.id}
									</output>
									<output className="ml-3" data-testid="all-split-layouts">
										{splits
											.map(
												(candidate) =>
													`${candidate.id}:${candidate.root.orientation}:${candidate.root.sizes.join(",")}:${leafOrder(candidate.root).join(",")}`
											)
											.join(" | ")}
									</output>
								</section>
								<ContextMenu>
									<ContextMenuTrigger
										data-testid="split-target"
										render={
											<div className="rounded-lg border border-border bg-card px-4 py-3 text-sm" />
										}
									>
										Right-click this split
									</ContextMenuTrigger>
									<ContextMenuContent>
										<SplitPresetMenuItems split={split} />
									</ContextMenuContent>
								</ContextMenu>
								<output
									className="block rounded-lg bg-muted p-3 text-sm"
									data-testid="apply-result"
								>
									{applyResult}
								</output>
							</div>
						</main>
						<SaveSplitPresetDialog />
					</TabsContext.Provider>
				</TooltipProvider>
			</I18nDirectionProvider>
		</I18nProvider>
	);
}

createRoot(document.getElementById("root")!).render(<SplitPresetsProof />);
