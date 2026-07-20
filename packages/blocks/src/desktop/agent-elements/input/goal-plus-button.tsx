"use client";

import {
	Add01Icon,
	AiImageIcon,
	Cancel01Icon,
	GhostIcon,
	Image01Icon,
	InformationCircleIcon,
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
import type { ReactNode } from "react";
import { memo, useState } from "react";

const PLUS_MENU_ITEM =
	"h-8 w-full items-center justify-start gap-2 rounded-md px-2 text-left font-medium text-sm";

const PLUS_MENU_SECTION_LABEL =
	"px-2 pt-2 pb-1 text-muted-foreground text-xs leading-none";

function PlusMenuSection({
	children,
	title,
}: {
	children: ReactNode;
	title: string;
}) {
	return (
		<div className="space-y-0.5">
			<div className={PLUS_MENU_SECTION_LABEL}>{title}</div>
			{children}
		</div>
	);
}

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
	goal,
	ghost,
	doubleCheck,
	imageGen,
	videoGen,
	pluginControls,
	disabled,
}: GoalPlusButtonProps) {
	const [open, setOpen] = useState(false);

	const showVerdict = Boolean(
		doubleCheck?.enabled && doubleCheck.result && !doubleCheck.checking
	);
	const verdictOk = doubleCheck?.result?.ok ?? false;
	const VerdictIcon = verdictOk ? Tick02Icon : InformationCircleIcon;
	const verdictTone = verdictOk ? "text-emerald-500" : "text-amber-500";

	return (
		<div className="flex items-center gap-1">
			<Popover onOpenChange={setOpen} open={open}>
				<PopoverTrigger
					render={
						<Button
							aria-label="Add"
							className="size-7 rounded-full text-muted-foreground"
							disabled={disabled}
							size="icon"
							type="button"
							variant="ghost"
						/>
					}
				>
					<HugeiconsIcon className="size-4" icon={Add01Icon} strokeWidth={2} />
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="max-h-[320px] w-[min(calc(100vw_-_24px),704px)] gap-1 overflow-y-auto rounded-2xl border-border/70 bg-popover/95 p-1.5 shadow-xl"
					side="top"
					sideOffset={6}
				>
					{onAttach && (
						<PlusMenuSection title="Add">
							<Button
								className={PLUS_MENU_ITEM}
								onClick={() => {
									onAttach();
									setOpen(false);
								}}
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon
									className="size-4 shrink-0 text-muted-foreground"
									icon={Image01Icon}
								/>
								<span className="flex-1">Files and images</span>
							</Button>
						</PlusMenuSection>
					)}
					{(imageGen || videoGen) && (
						<PlusMenuSection title="Create">
							{imageGen && (
								<Button
									className={PLUS_MENU_ITEM}
									disabled={imageGen.disabled || imageGen.generating}
									onClick={() => {
										imageGen.onGenerate();
										setOpen(false);
									}}
									type="button"
									variant="ghost"
								>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={AiImageIcon}
									/>
									<span className="flex-1">Generate image</span>
									{imageGen.generating && (
										<span className="text-muted-foreground text-xs">
											working...
										</span>
									)}
								</Button>
							)}
							{videoGen && (
								<Button
									className={PLUS_MENU_ITEM}
									disabled={videoGen.disabled || videoGen.generating}
									onClick={() => {
										videoGen.onGenerate();
										setOpen(false);
									}}
									type="button"
									variant="ghost"
								>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={Video01Icon}
									/>
									<span className="flex-1">Generate video</span>
									{videoGen.generating && (
										<span className="text-muted-foreground text-xs">
											working...
										</span>
									)}
								</Button>
							)}
						</PlusMenuSection>
					)}
					{(goal || doubleCheck || pluginControls?.length) && (
						<PlusMenuSection title="Assist">
							{goal && (
								<button
									className={cn(PLUS_MENU_ITEM, "flex hover:bg-accent")}
									onClick={() => {
										goal.onPursueToggle();
										setOpen(false);
									}}
									type="button"
								>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={Target01Icon}
									/>
									<span className="flex-1">Pursue goal</span>
									<Switch
										aria-label="Pursue goal"
										checked={goal.active}
										className="pointer-events-none"
										tabIndex={-1}
									/>
								</button>
							)}
							{doubleCheck && (
								<button
									className={cn(PLUS_MENU_ITEM, "flex hover:bg-accent")}
									onClick={() => doubleCheck.onToggle(!doubleCheck.enabled)}
									title="Double-check: have a second model review each answer"
									type="button"
								>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={Tick02Icon}
									/>
									<span className="flex-1">Double-check</span>
									{doubleCheck.enabled && doubleCheck.checking && (
										<span className="text-muted-foreground text-xs">
											checking...
										</span>
									)}
									<Switch
										aria-label="Double-check"
										checked={doubleCheck.enabled}
										className="pointer-events-none"
										tabIndex={-1}
									/>
								</button>
							)}
							{pluginControls?.map((control) => (
								<button
									className={cn(PLUS_MENU_ITEM, "flex hover:bg-accent")}
									key={control.id}
									onClick={() => control.onToggle(control.flag, !control.enabled)}
									title={control.description ?? control.label}
									type="button"
								>
									<HugeiconsIcon
										className="size-4 shrink-0 text-muted-foreground"
										icon={Tick02Icon}
									/>
									<span className="flex-1">{control.label}</span>
									<Switch
										aria-label={control.label}
										checked={control.enabled}
										className="pointer-events-none"
										tabIndex={-1}
									/>
								</button>
							))}
						</PlusMenuSection>
					)}
					{ghost && (
						<button
							className={cn(PLUS_MENU_ITEM, "flex hover:bg-accent")}
							onClick={() => {
								ghost.onToggle();
								setOpen(false);
							}}
							title="Temporary chat — this thread isn't saved to Ryu history"
							type="button"
						>
							<HugeiconsIcon
								className="size-4 shrink-0 text-muted-foreground"
								icon={GhostIcon}
							/>
							<span className="flex-1">Temporary chat</span>
							<Switch
								aria-label="Temporary chat"
								checked={ghost.active}
								className="pointer-events-none"
								tabIndex={-1}
							/>
						</button>
					)}
				</PopoverContent>
			</Popover>

			{goal?.active && (
				<button
					aria-label="Remove goal"
					className={cn(
						"group relative flex size-7 shrink-0 items-center justify-center rounded-full",
						"bg-primary/10 text-primary transition-colors hover:bg-destructive/15 hover:text-destructive"
					)}
					onClick={goal.onRemove}
					title="Goal active — click to remove"
					type="button"
				>
					{/* Target icon (default) morphs into a close icon on hover. */}
					<HugeiconsIcon
						className="absolute size-4 opacity-100 transition-opacity duration-150 group-hover:opacity-0"
						icon={Target01Icon}
					/>
					<HugeiconsIcon
						className="absolute size-4 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
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
								aria-label="Show double-check result"
								className={cn("size-7 shrink-0 rounded-full", verdictTone)}
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
						className="max-w-sm rounded-2xl p-3"
						side="top"
						sideOffset={6}
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
