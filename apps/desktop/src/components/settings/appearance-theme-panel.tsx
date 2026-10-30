import {
	Cancel01Icon,
	Delete02Icon,
	FloppyDiskIcon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	Select,
	SelectContent,
	SelectTrigger,
} from "@ryu/ui/components/select.tsx";
import { useState } from "react";
import {
	type CustomTokens,
	findVariant,
	type GroupedVariants,
} from "@/src/lib/themes/presets.ts";
import {
	ColorField,
	PresetSelectGroups,
	PresetSwatch,
	PrimaryColorField,
	shareTheme,
} from "./appearance-preset-fields.tsx";
import { COLOR_FIELDS } from "./appearance-tab-model.ts";

export interface ThemePanelProps {
	baseTokens: CustomTokens;
	dirty: boolean;
	groups: GroupedVariants;
	label: string;
	mode: "light" | "dark";
	onDeletePreset: (id: string) => void;
	onDiscardClick: () => void;
	onSaveCancel: () => void;
	onSaveClick: () => void;
	onSaveConfirm: () => void;
	onSaveNameChange: (name: string) => void;
	onSelectPreset: (id: string | null) => void;
	onTokenChange: (key: keyof CustomTokens, value: string) => void;
	saveDialogOpen: boolean;
	saveName: string;
	selectedId: string;
	tokens: CustomTokens;
}

export function ThemePanel({
	mode,
	label,
	groups,
	selectedId,
	tokens,
	dirty,
	saveDialogOpen,
	saveName,
	onSelectPreset,
	onTokenChange,
	onSaveClick,
	onDeletePreset,
	onDiscardClick,
	onSaveNameChange,
	onSaveConfirm,
	onSaveCancel,
}: ThemePanelProps) {
	const tl = useLiteralMessages();
	const selected = findVariant(selectedId);
	// Hold the id being confirmed, not a bare boolean: picking a different preset
	// mid-confirm then re-selects the state away instead of leaving an armed
	// "Delete" pointed at whatever is now selected.
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
	// Only a locally-saved theme can be deleted here. A built-in has no storage to
	// remove, and an installed one belongs to its plugin — that is an uninstall in
	// the Store, not a delete in Appearance. Answered from `groups.custom` rather
	// than `variantSource()` so this stays free: the panel re-renders on every
	// colour-picker drag, and that helper re-reads and re-parses localStorage.
	const canDelete = !dirty && groups.custom.some((v) => v.id === selectedId);
	const confirming = canDelete && confirmDeleteId === selectedId;

	return (
		<div className="space-y-3">
			<div>
				<h3 className="mb-1 font-medium text-sm">
					{tl("{label} theme", { label })}
				</h3>
				<p className="mb-2 text-muted-foreground text-xs">
					{tl("Used when {mode} mode is active.", { mode })}
				</p>
				<div className="flex items-center gap-2">
					<Select
						onValueChange={onSelectPreset}
						value={dirty ? "" : selectedId}
					>
						<SelectTrigger className="h-9 w-full">
							{dirty ? (
								<span className="flex items-center gap-2">
									<PresetSwatch
										bg={tokens.background}
										primary={tokens.primary}
										surface={tokens.sidebar}
									/>
									<span className="text-muted-foreground italic">
										Unsaved theme
									</span>
								</span>
							) : selected ? (
								<span className="flex items-center gap-2">
									<PresetSwatch
										bg={selected.preview.bg}
										primary={selected.preview.primary}
										surface={selected.preview.surface}
									/>
									<span>{selected.label}</span>
								</span>
							) : (
								// The stored id resolves to no known variant — its theme
								// plugin was uninstalled, or the preset was renamed. A bare
								// <SelectValue /> here would print that dead id verbatim,
								// because Base UI resolves the closed trigger from the root's
								// `items` prop and this root has none (the list is grouped).
								<span className="text-muted-foreground italic">
									Select a theme
								</span>
							)}
						</SelectTrigger>
						<SelectContent>
							<PresetSelectGroups groups={groups} />
						</SelectContent>
					</Select>
					{canDelete && !confirming && (
						<>
							<Button
								aria-label={tl("Share {label}", {
									label: selected?.label ?? "theme",
								})}
								className="h-9 w-9 shrink-0"
								onClick={() => selected && shareTheme(selected)}
								size="icon"
								title="Copy a publishable plugin manifest for this theme"
								variant="ghost"
							>
								<HugeiconsIcon icon={Share08Icon} size={14} />
							</Button>
							<Button
								aria-label={tl("Delete {label}", {
									label: selected?.label ?? "theme",
								})}
								className="h-9 w-9 shrink-0"
								onClick={() => setConfirmDeleteId(selectedId)}
								size="icon"
								title={tl("Delete {label}", {
									label: selected?.label ?? "theme",
								})}
								variant="ghost"
							>
								<HugeiconsIcon icon={Delete02Icon} size={14} />
							</Button>
						</>
					)}
				</div>
				{confirming && (
					<div className="mt-2 flex items-center gap-2">
						<span className="flex-1 text-muted-foreground text-xs">
							{tl("Delete “{label}”?", { label: selected?.label ?? "" })}
						</span>
						<Button
							onClick={() => {
								setConfirmDeleteId(null);
								onDeletePreset(selectedId);
							}}
							size="dense"
							variant="destructive"
						>
							Delete
						</Button>
						<Button
							onClick={() => setConfirmDeleteId(null)}
							size="dense"
							variant="ghost"
						>
							Cancel
						</Button>
					</div>
				)}
			</div>

			<div className="space-y-1.5">
				{COLOR_FIELDS.map(({ key, label: fieldLabel }) =>
					key === "primary" ? (
						<PrimaryColorField
							key={key}
							mode={mode}
							onChange={onTokenChange}
							value={tokens.primary}
						/>
					) : (
						<ColorField
							fieldKey={key}
							key={key}
							label={fieldLabel}
							mode={mode}
							onChange={onTokenChange}
							value={tokens[key]}
						/>
					)
				)}
			</div>

			{dirty && !saveDialogOpen && (
				<div className="flex gap-2">
					<Button
						className="flex-1"
						onClick={onSaveClick}
						size="compact"
						variant="default"
					>
						<HugeiconsIcon icon={FloppyDiskIcon} size={14} />
						Save as preset
					</Button>
					<Button onClick={onDiscardClick} size="compact" variant="ghost">
						<HugeiconsIcon icon={Cancel01Icon} size={14} />
						Discard
					</Button>
				</div>
			)}

			{saveDialogOpen && (
				<div className="flex items-center gap-2">
					<Input
						aria-label="Preset name"
						autoFocus
						className="flex-1"
						onChange={(e) => onSaveNameChange(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								onSaveConfirm();
							}
							if (e.key === "Escape") {
								onSaveCancel();
							}
						}}
						placeholder="Preset name…"
						size="dense"
						value={saveName}
					/>
					<Button
						disabled={!saveName.trim()}
						onClick={onSaveConfirm}
						size="dense"
						variant="default"
					>
						Save
					</Button>
					<Button onClick={onSaveCancel} size="dense" variant="ghost">
						Cancel
					</Button>
				</div>
			)}
		</div>
	);
}
