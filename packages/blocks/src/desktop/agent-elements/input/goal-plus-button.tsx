"use client";

import {
	Add01Icon,
	AiImageIcon,
	Cancel01Icon,
	GhostIcon,
	Image01Icon,
	InformationCircleIcon,
	PencilEdit01Icon,
	Target01Icon,
	Tick02Icon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Switch } from "@ryu/ui/components/switch";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useCallback, useState } from "react";
import { useComposerPins } from "../../../composer/composer-pins.ts";
import {
	ComposerMenu,
	type ComposerMenuGroup,
	type ComposerMenuItem,
} from "./composer-menu.tsx";

export interface GoalControls {
	/** Whether a goal is currently active on this conversation. */
	active: boolean;
	/**
	 * Toggle goal pursuit from the dropdown. When inactive this opens a goal draft
	 * for the user to type the condition; when active it clears the goal.
	 */
	onPursueToggle: () => void;
	/** Remove the active goal (the chip's close action). */
	onRemove: () => void;
}

export type DoubleCheckResultView = {
	ok: boolean;
	critique: string;
	model: string;
} | null;

export interface DoubleCheckControls {
	/** True while a review is in flight. */
	checking: boolean;
	/** Whether double-check is on for this conversation. */
	enabled: boolean;
	/** Toggle double-check on/off. */
	onToggle: (next: boolean) => void;
	/** The latest review of the most recent answer (null until one runs). */
	result: DoubleCheckResultView;
}

/** A plugin-contributed composer toggle row (`contributes.composer_controls` of
 *  type `toggle`). Rendered in the "+" dropdown's Assist section using the same
 *  markup as the built-in double-check toggle; flipping it sets `flag` in the
 *  per-request `plugin_flags` map. */
export interface PluginComposerControlRow {
	/** Optional one-line hint (shown as the row's `title`). */
	description?: string;
	/** Whether the toggle is currently on for this conversation. */
	enabled: boolean;
	/** The `plugin_flags` key this toggle sets. */
	flag: string;
	/** Stable control id (React key). */
	id: string;
	/** Row label. */
	label: string;
	/** Flip the toggle: `(flag, next)`. */
	onToggle: (flag: string, next: boolean) => void;
}

/** Temporary ("ghost") chat toggle for the "+" dropdown. When on, the thread
 *  isn't saved to Ryu history — Ryu's analogue of an incognito chat. */
export interface GhostControls {
	/** Whether temporary chat is currently on for this thread. */
	active: boolean;
	/** Toggle temporary chat (flipping it starts a fresh, unsaved thread). */
	onToggle: () => void;
}

/** A "generate media from the composer text" action in the "+" dropdown. */
export interface MediaGenControls {
	/** Disable the row (e.g. empty composer or a run is streaming). */
	disabled?: boolean;
	/** True while a generation is in flight — disables the row + shows a spinner hint. */
	generating: boolean;
	/** Run the generation (the host reads the composer text as the prompt). */
	onGenerate: () => void;
}

export interface GoalPlusButtonProps {
	/** Apps, plugins, and context references shown in the shared searchable list. */
	directoryGroups?: ComposerMenuGroup[];
	/** Text typed into the composer while the + menu is open. */
	directoryQuery?: string;
	disabled?: boolean;
	/**
	 * Double-check affordances. When provided, the dropdown gains a "Double-check"
	 * toggle row (a second model reviews each answer), and a verdict badge appears
	 * next to the "+" once a review has run.
	 */
	doubleCheck?: DoubleCheckControls;
	/**
	 * Temporary-chat affordance. When provided, the dropdown gains a "Temporary
	 * chat" toggle row. Omit to hide it (e.g. once a thread has messages, which
	 * can't retroactively become temporary).
	 */
	ghost?: GhostControls;
	/** Goal affordances. Optional so the menu can host media gen without a goal. */
	goal?: GoalControls;
	/** "Generate image" menu item (Core's /api/images/generate). */
	imageGen?: MediaGenControls;
	/** "Add photos & files" action. Omitted item when undefined. */
	onAttach?: () => void;
	onDirectorySelect?: (item: ComposerMenuItem) => void;
	onMenuOpenChange?: (open: boolean) => void;
	/** Open the app-owned sketch dialog. Omitted when Drawesome is unavailable. */
	onSketch?: () => void;
	/**
	 * Toggles contributed by enabled plugins (`composer_controls`). Each renders as
	 * a toggle row in the Assist section, mirroring the built-in double-check row.
	 */
	pluginControls?: PluginComposerControlRow[];
	/** "Generate video" menu item (Core's /api/video/generate). */
	videoGen?: MediaGenControls;
}

/**
 * The composer's "+" button, upgraded to a menu: it opens a dropdown offering
 * "Add photos & files", a "Pursue goal" toggle, and a "Double-check" toggle.
 * When a goal is active, a chip appears next to the "+"; the chip shows the goal
 * (target) icon and morphs into a close (×) icon on hover so a single click
 * removes the goal. When double-check has produced a verdict, a badge sits beside
 * the "+" (green tick = looks correct, amber info = possible issues) that opens a
 * popover with the critique.
 */
export const GoalPlusButton = memo(function GoalPlusButton({
	onAttach,
	onSketch,
	goal,
	ghost,
	doubleCheck,
	imageGen,
	videoGen,
	pluginControls,
	disabled,
	directoryGroups = [],
	directoryQuery = "",
	onDirectorySelect,
	onMenuOpenChange,
}: GoalPlusButtonProps) {
	const [open, setOpen] = useState(false);
	const { pinnedIds, togglePin } = useComposerPins();
	const handleTogglePin = useCallback(
		(item: ComposerMenuItem) => togglePin(item.id),
		[togglePin]
	);
	const handleOpenChange = (next: boolean) => {
		setOpen(next);
		onMenuOpenChange?.(next);
	};
	const handlePopoverOpenChange = (
		next: boolean,
		details: { reason?: string }
	) => {
		// The shared + directory deliberately returns focus to the textarea so the
		// user can search it by typing. Base UI reports that hand-off as focus-out;
		// keep the controlled popup open for that one close reason.
		if (!next && details.reason === "focus-out") {
			return;
		}
		handleOpenChange(next);
	};

	const showVerdict = Boolean(
		doubleCheck?.enabled && doubleCheck.result && !doubleCheck.checking
	);
	const verdictOk = doubleCheck?.result?.ok ?? false;
	const VerdictIcon = verdictOk ? Tick02Icon : InformationCircleIcon;
	const verdictTone = verdictOk ? "text-status-success" : "text-status-warning";
	const menuGroups: ComposerMenuGroup[] = [];
	const addItems: ComposerMenuItem[] = [];
	if (onAttach) {
		addItems.push({
			id: "action:attach",
			label: "Files and images",
			description: "Attach context from this device",
			icon: <HugeiconsIcon className="size-4" icon={Image01Icon} />,
		});
	}
	if (onSketch) {
		addItems.push({
			id: "action:sketch",
			label: "Sketch",
			description: "Draw a visual reference to attach",
			icon: <HugeiconsIcon className="size-4" icon={PencilEdit01Icon} />,
		});
	}
	if (addItems.length > 0) {
		menuGroups.push({ id: "add", label: "Add", items: addItems });
	}
	const createItems: ComposerMenuItem[] = [];
	if (imageGen) {
		createItems.push({
			id: "action:image",
			label: "Generate image",
			icon: <HugeiconsIcon className="size-4" icon={AiImageIcon} />,
			disabled: imageGen.disabled || imageGen.generating,
			badge: imageGen.generating ? "Working…" : undefined,
		});
	}
	if (videoGen) {
		createItems.push({
			id: "action:video",
			label: "Generate video",
			icon: <HugeiconsIcon className="size-4" icon={Video01Icon} />,
			disabled: videoGen.disabled || videoGen.generating,
			badge: videoGen.generating ? "Working…" : undefined,
		});
	}
	if (createItems.length > 0) {
		menuGroups.push({ id: "create", label: "Create", items: createItems });
	}
	const assistItems: ComposerMenuItem[] = [];
	if (goal) {
		assistItems.push({
			id: "action:goal",
			label: "Pursue goal",
			icon: <HugeiconsIcon className="size-4" icon={Target01Icon} />,
			trailing: (
				<Switch
					aria-label="Pursue goal"
					checked={goal.active}
					className="pointer-events-none"
					tabIndex={-1}
				/>
			),
		});
	}
	if (doubleCheck) {
		assistItems.push({
			id: "action:double-check",
			label: "Double-check",
			description: "Have a second model review each answer",
			icon: <HugeiconsIcon className="size-4" icon={Tick02Icon} />,
			badge:
				doubleCheck.enabled && doubleCheck.checking ? "Checking…" : undefined,
			trailing: (
				<Switch
					aria-label="Double-check"
					checked={doubleCheck.enabled}
					className="pointer-events-none"
					tabIndex={-1}
				/>
			),
		});
	}
	for (const control of pluginControls ?? []) {
		assistItems.push({
			id: `control:${control.id}`,
			label: control.label,
			description: control.description,
			icon: <HugeiconsIcon className="size-4" icon={Tick02Icon} />,
			trailing: (
				<Switch
					aria-label={control.label}
					checked={control.enabled}
					className="pointer-events-none"
					tabIndex={-1}
				/>
			),
		});
	}
	if (ghost) {
		assistItems.push({
			id: "action:ghost",
			label: "Temporary chat",
			description: "This thread is not saved to Ryu history",
			icon: <HugeiconsIcon className="size-4" icon={GhostIcon} />,
			trailing: (
				<Switch
					aria-label="Temporary chat"
					checked={ghost.active}
					className="pointer-events-none"
					tabIndex={-1}
				/>
			),
		});
	}
	if (assistItems.length > 0) {
		menuGroups.push({ id: "assist", label: "Assist", items: assistItems });
	}
	menuGroups.push(...directoryGroups);

	const handleMenuSelect = (item: ComposerMenuItem) => {
		if (item.id === "action:attach") {
			onAttach?.();
		} else if (item.id === "action:sketch") {
			onSketch?.();
		} else if (item.id === "action:image") {
			imageGen?.onGenerate();
		} else if (item.id === "action:video") {
			videoGen?.onGenerate();
		} else if (item.id === "action:goal") {
			goal?.onPursueToggle();
		} else if (item.id === "action:double-check") {
			doubleCheck?.onToggle(!doubleCheck.enabled);
		} else if (item.id === "action:ghost") {
			ghost?.onToggle();
		} else if (item.id.startsWith("control:")) {
			const control = pluginControls?.find(
				(candidate) => `control:${candidate.id}` === item.id
			);
			if (control) {
				control.onToggle(control.flag, !control.enabled);
			}
		} else {
			onDirectorySelect?.(item);
		}
		handleOpenChange(false);
	};

	return (
		<div className="flex items-center gap-1">
			<Popover onOpenChange={handlePopoverOpenChange} open={open}>
				<PopoverTrigger
					render={
						<Button
							aria-label="Add"
							className="size-7"
							disabled={disabled}
							radius="pill"
							size="icon"
							type="button"
							variant="ghost-muted"
						/>
					}
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} strokeWidth={2} />
				</PopoverTrigger>
				<PopoverContent
					align="start"
					appearance="composer-menu"
					className="w-[min(calc(100vw_-_32px),704px)]"
					corners="rounded"
					side="top"
					sideOffset={8}
					spacing="dense-menu"
				>
					<ComposerMenu
						embedded
						groups={menuGroups}
						onDismiss={() => handleOpenChange(false)}
						onSelect={handleMenuSelect}
						onTogglePin={handleTogglePin}
						pinnedItemIds={pinnedIds}
						query={directoryQuery}
					/>
				</PopoverContent>
			</Popover>

			{goal?.active && (
				<button
					aria-label="Remove goal"
					className={cn(
						"group relative flex size-7 shrink-0 items-center justify-center rounded-full",
						"bg-primary/10 text-primary transition-colors hover:bg-destructive/15 hover:text-status-destructive focus-visible:bg-destructive/15 focus-visible:text-status-destructive"
					)}
					onClick={goal.onRemove}
					title="Goal active — click to remove"
					type="button"
				>
					{/* Target icon (default) morphs into a close icon on hover. */}
					<HugeiconsIcon
						className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
						icon={Target01Icon}
					/>
					<HugeiconsIcon
						className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
						icon={Cancel01Icon}
						strokeWidth={2}
					/>
				</button>
			)}

			{showVerdict && doubleCheck?.result && (
				<Popover>
					<PopoverTrigger
						render={
							<Button
								appearance={
									verdictOk ? "goal-verdict-success" : "goal-verdict-warning"
								}
								aria-label="Show double-check result"
								size="icon"
								title={
									verdictOk
										? "Double-check: looks correct"
										: "Double-check: possible issues"
								}
								type="button"
								variant="ghost"
							/>
						}
					>
						<HugeiconsIcon className="size-4" icon={VerdictIcon} />
					</PopoverTrigger>
					<PopoverContent
						align="start"
						className="max-w-sm"
						corners="rounded"
						side="top"
						sideOffset={6}
						spacing="rail"
					>
						<div className="flex items-center gap-1.5 font-medium text-sm">
							<HugeiconsIcon
								className={cn("size-4", verdictTone)}
								icon={VerdictIcon}
							/>
							{verdictOk ? "Looks correct" : "Possible issues"}
						</div>
						<p className="mt-1 whitespace-pre-wrap text-muted-foreground text-sm">
							{doubleCheck.result.critique}
						</p>
						<div className="mt-2 text-muted-foreground text-xs">
							{doubleCheck.result.model}
						</div>
					</PopoverContent>
				</Popover>
			)}
		</div>
	);
});
