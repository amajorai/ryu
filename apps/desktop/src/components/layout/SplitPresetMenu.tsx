// The pane-layout preset controls, in one place because they hang off three
// different split surfaces: the per-tab "Split view" submenu, the strip's split
// bracket, and the vertical sidebar's split block. Each renders the same items,
// so a user who learns them in one menu finds them in the others.
//
// The save flow needs a name, and a context menu unmounts the instant an item
// is clicked — so the dialog is hosted ONCE (next to the command palette in
// Layout) and driven by a tiny store, the same shape as `useCreateAgentDialog`.

import {
	BookmarkAdd01Icon,
	DistributeHorizontalCenterIcon,
	Layout01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
} from "@ryu/ui/components/context-menu.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { Fragment, useEffect, useState } from "react";
import { create } from "zustand";
import { type Split, useTabsContext } from "@/src/contexts/TabsContext.tsx";
import {
	BUILTIN_PRESETS,
	presetFromSplit,
	presetSlotCount,
	presetSummary,
	type SplitPreset,
} from "@/src/lib/splitPresets.ts";
import { isEqualized, leafOrder } from "@/src/lib/splitTree.ts";
import { useSplitPresetStore } from "@/src/store/useSplitPresetStore.ts";

interface SaveSplitPresetDialogState {
	close: () => void;
	openFor: (splitId: string) => void;
	/** The split being captured, or null when the dialog is closed. */
	splitId: string | null;
}

const useSaveSplitPresetDialog = create<SaveSplitPresetDialogState>((set) => ({
	splitId: null,
	openFor: (splitId) => set({ splitId }),
	close: () => set({ splitId: null }),
}));

/** Suggest a name from the shape, so saving is one keystroke for most users. */
function suggestName(split: Split, taken: string[]): string {
	const base = `${leafOrder(split.root).length}-pane layout`;
	if (!taken.some((n) => n.toLowerCase() === base.toLowerCase())) {
		return base;
	}
	let n = 2;
	while (taken.some((t) => t.toLowerCase() === `${base} ${n}`.toLowerCase())) {
		n += 1;
	}
	return `${base} ${n}`;
}

/** Mounted once (Layout). Names the current pane layout and stores it. */
export function SaveSplitPresetDialog() {
	const { splitId, close } = useSaveSplitPresetDialog();
	const { tabs, splits } = useTabsContext();
	const { presets, savePreset } = useSplitPresetStore();
	const split = splits.find((s) => s.id === splitId);
	const [name, setName] = useState("");
	const [pinRoutes, setPinRoutes] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Re-seed each time the dialog opens on a split, not on every render.
	useEffect(() => {
		if (split) {
			setError(null);
			setName(
				suggestName(
					split,
					presets.map((p) => p.name)
				)
			);
			setPinRoutes(false);
		}
		// `presets` is read only to avoid a duplicate suggestion; re-suggesting
		// mid-edit would overwrite what the user is typing.
		// seed on open only
	}, [split?.id]);

	const commit = () => {
		if (!(split && name.trim())) {
			return;
		}
		const pathOf = (tabId: string) => tabs.find((t) => t.id === tabId)?.path;
		try {
			const saved = savePreset(
				name,
				presetFromSplit(split.root, pathOf, { pinRoutes })
			);
			if (!saved) {
				setError(
					"The saved layout limit has been reached. Use an existing name to replace a layout, or delete a saved layout first."
				);
				return;
			}
			close();
		} catch {
			setError(
				"Could not save this layout. Check available storage and try again."
			);
		}
	};

	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					close();
				}
			}}
			open={!!split}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Save layout as preset</DialogTitle>
					<DialogDescription>
						Stores the arrangement of the panes — how many, side by side or
						stacked, and how the space is divided — so you can lay it out again
						any time.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					{error && (
						<p className="text-destructive text-sm" role="alert">
							{error}
						</p>
					)}
					<div className="flex flex-col gap-2">
						<Label htmlFor="split-preset-name">Name</Label>
						<Input
							// naming is the whole dialog
							autoFocus
							id="split-preset-name"
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									commit();
								}
							}}
							placeholder="Review layout"
							value={name}
						/>
					</div>
					<Label htmlFor="split-preset-pin-routes" spacing="split-choice">
						<Checkbox
							checked={pinRoutes}
							id="split-preset-pin-routes"
							onCheckedChange={(checked) => setPinRoutes(checked === true)}
						/>
						<span className="flex flex-col gap-1">
							<span className="font-medium text-sm">
								Remember what each pane was showing
							</span>
							<span className="text-muted-foreground text-xs">
								Reopens the same pages in the same panes. Leave this off to save
								just the shape and choose the contents each time.
							</span>
						</span>
					</Label>
				</div>
				<DialogFooter>
					<Button onClick={close} type="button" variant="ghost">
						Cancel
					</Button>
					<Button disabled={!name.trim()} onClick={commit} type="button">
						Save preset
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The "Apply preset" list — built-ins first, then the user's own.
 *
 *  A preset applies one of two ways, and the row's subtitle says which:
 *  when it has exactly as many panes as the split the menu was opened on, it
 *  RE-TILES those panes (the tabs you are looking at keep their contents and
 *  take the preset's arrangement); otherwise it lays the shape out over NEW
 *  panes, each opening its remembered page or the empty-pane picker.
 *
 *  The pane-count match is exact on purpose. `buildPresetTree` ignores surplus
 *  ids, so re-tiling a 4-pane split with a 3-slot preset would leave the fourth
 *  tab out of the new tree — and `reconcileSplits` would graft it back onto the
 *  root flat, quietly mangling the nesting the preset was chosen for. */
function ApplyPresetSubmenu({ split }: { split: Split | null }) {
	const tl = useLiteralMessages();
	const { applySplitPreset, applySplitPresetToNewTabs } = useTabsContext();
	const presets = useSplitPresetStore((s) => s.presets);
	const rows: SplitPreset[] = [...BUILTIN_PRESETS, ...presets];
	// Pane order, so slot i takes the tab currently in pane i — re-tiling keeps
	// panes as close to where they were as the new shape allows.
	const paneIds = split ? leafOrder(split.root) : [];
	return (
		<ContextMenuSub>
			<ContextMenuSubTrigger>
				<HugeiconsIcon className="size-4" icon={Layout01Icon} />
				Apply layout preset
			</ContextMenuSubTrigger>
			<ContextMenuSubContent>
				{rows.map((preset, i) => {
					const retiles = paneIds.length === presetSlotCount(preset.root);
					return (
						<Fragment key={preset.id}>
							{i === BUILTIN_PRESETS.length && <ContextMenuSeparator />}
							<ContextMenuItem
								onClick={() =>
									retiles
										? applySplitPreset(preset.root, paneIds)
										: applySplitPresetToNewTabs(preset.root)
								}
							>
								<span className="flex min-w-0 flex-col">
									<span className="truncate" title={preset.name}>
										{preset.name}
									</span>
									<span className="text-muted-foreground text-xs">
										{retiles
											? tl("Rearranges these {paneCount} panes", {
													paneCount: paneIds.length,
												})
											: tl("Opens {presetSummary}", {
													presetSummary: presetSummary(preset),
												})}
									</span>
								</span>
							</ContextMenuItem>
						</Fragment>
					);
				})}
			</ContextMenuSubContent>
		</ContextMenuSub>
	);
}

/** The preset + equalize items every split surface shows. `split` is null when
    the surface has no live split (the per-tab menu on an unsplit tab), in which
    case only "Apply" is offered. */
export function SplitPresetMenuItems({ split }: { split: Split | null }) {
	const { equalizeSplit } = useTabsContext();
	const openFor = useSaveSplitPresetDialog((s) => s.openFor);
	return (
		<>
			<ApplyPresetSubmenu split={split} />
			{split && (
				<>
					<ContextMenuItem onClick={() => openFor(split.id)}>
						<HugeiconsIcon className="size-4" icon={BookmarkAdd01Icon} />
						Save layout as preset
					</ContextMenuItem>
					{/* Disabled once the panes are already even — the action would do
					    nothing, and greying it out says why. */}
					<ContextMenuItem
						disabled={isEqualized(split.root)}
						onClick={() => equalizeSplit(split.id)}
					>
						<HugeiconsIcon
							className="size-4"
							icon={DistributeHorizontalCenterIcon}
						/>
						Equalize panes
					</ContextMenuItem>
				</>
			)}
		</>
	);
}
