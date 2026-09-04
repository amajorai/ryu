// Managing saved pane layouts.
//
// Presets are CREATED from the split view's own context menus (that is where a
// live layout exists to capture) — this section is the other half: seeing what
// you have saved, renaming one, and throwing one away. It lives next to the
// Tabs settings because a split is a tab arrangement, and it is the only place
// a preset can be deleted, since `savePreset` replaces by name rather than
// stacking duplicates.
//
// Built-in layouts are deliberately absent: they ship in code, cannot be
// renamed or removed, and listing them here would offer controls that do
// nothing.

import { Delete02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useState } from "react";
import { presetSummary } from "@/src/lib/splitPresets.ts";
import { useSplitPresetStore } from "@/src/store/useSplitPresetStore.ts";
import {
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "./shared/settings-items.tsx";

export function SplitPresetSettings() {
	const { presets, renamePreset, deletePreset, reload } = useSplitPresetStore();
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const [confirmId, setConfirmId] = useState<string | null>(null);

	const beginRename = (id: string, name: string) => {
		setConfirmId(null);
		setDraft(name);
		setEditingId(id);
	};

	// Settings sync writes the collection straight into localStorage without
	// announcing it, so re-read on mount — otherwise presets that arrived from
	// another machine would not show up until the window is restarted.
	useEffect(() => {
		reload();
	}, [reload]);

	const commitRename = (id: string) => {
		renamePreset(id, draft);
		setEditingId(null);
	};

	return (
		<SettingsSection
			caption="Saved from a split view's context menu (Split view → Save layout as preset). A preset stores the arrangement (how many panes, side by side or stacked, and how the space is divided), and applying it lays that shape out again."
			title="Pane layouts"
		>
			<SettingsGroup>
				<SettingsItem
					actions={
						<span className="text-muted-foreground text-xs">
							{presets.length === 0
								? "None saved yet"
								: `${presets.length} saved`}
						</span>
					}
					settingsId="general.tabs.split-layout-presets"
					title="Pane layout presets"
				/>
				{presets.map((preset) => (
					<SettingsItem
						actions={
							editingId === preset.id || confirmId === preset.id ? null : (
								<>
									<Button
										aria-label={`Rename ${preset.name}`}
										className="size-8"
										onClick={() => beginRename(preset.id, preset.name)}
										size="icon"
										title={`Rename ${preset.name}`}
										variant="ghost"
									>
										<HugeiconsIcon icon={PencilEdit01Icon} size={14} />
									</Button>
									<Button
										aria-label={`Delete ${preset.name}`}
										className="size-8"
										onClick={() => {
											setEditingId(null);
											setConfirmId(preset.id);
										}}
										size="icon"
										title={`Delete ${preset.name}`}
										variant="ghost"
									>
										<HugeiconsIcon icon={Delete02Icon} size={14} />
									</Button>
								</>
							)
						}
						key={preset.id}
						title={
							/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: the adjacent rename button remains keyboard accessible; double-click is the pointer shortcut for the same inline editor */
							<span
								className="flex min-w-0 cursor-text flex-col"
								onDoubleClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
									beginRename(preset.id, preset.name);
								}}
							>
								<span className="truncate">{preset.name}</span>
								<span className="font-normal text-muted-foreground text-xs">
									{presetSummary(preset)}
								</span>
							</span>
						}
					>
						{editingId === preset.id && (
							<div className="flex items-center gap-2">
								<Input
									aria-label={`New name for ${preset.name}`}
									// biome-ignore lint/a11y/noAutofocus: the row turned into this field on request
									autoFocus
									className="h-8"
									onChange={(e) => setDraft(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") {
											commitRename(preset.id);
										}
										if (e.key === "Escape") {
											setEditingId(null);
										}
									}}
									value={draft}
								/>
								<Button
									className="h-8 px-3 text-xs"
									disabled={!draft.trim()}
									onClick={() => commitRename(preset.id)}
									size="sm"
								>
									Rename
								</Button>
								<Button
									className="h-8 px-3 text-xs"
									onClick={() => setEditingId(null)}
									size="sm"
									variant="ghost"
								>
									Cancel
								</Button>
							</div>
						)}
						{confirmId === preset.id && (
							<div className="flex items-center gap-2">
								<span className="flex-1 text-muted-foreground text-xs">
									Delete “{preset.name}”? Panes already open are not affected.
								</span>
								<Button
									className="h-8 px-3 text-xs"
									onClick={() => {
										deletePreset(preset.id);
										setConfirmId(null);
									}}
									size="sm"
									variant="destructive"
								>
									Delete
								</Button>
								<Button
									className="h-8 px-3 text-xs"
									onClick={() => setConfirmId(null)}
									size="sm"
									variant="ghost"
								>
									Cancel
								</Button>
							</div>
						)}
					</SettingsItem>
				))}
			</SettingsGroup>
		</SettingsSection>
	);
}
