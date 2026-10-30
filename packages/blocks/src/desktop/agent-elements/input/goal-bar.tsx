"use client";

import {
	Cancel01Icon,
	CheckmarkCircle02Icon,
	Clock01Icon,
	PauseIcon,
	PencilEdit01Icon,
	PlayIcon,
	Target01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useRef, useState } from "react";
import { formatGoalElapsed, getGoalElapsedMs } from "../goal-message.ts";

export interface GoalBarProps {
	/** True once the goal has been achieved (shown as a success state). */
	achieved?: boolean;
	/** Unix milliseconds when the goal was achieved, if it has completed. */
	achievedAt?: number;
	/** True while a judge evaluation is in flight. */
	judging?: boolean;
	/**
	 * Cancel an empty draft (user opened the bar via the toggle then backed out
	 * without entering a condition). Only meaningful when `startInEdit` and the
	 * text is empty.
	 */
	onCancelDraft?: () => void;
	/** Clear the goal entirely (the bar's close button). */
	onClear: () => void;
	/** Persistently pause the goal loop. */
	onPause?: () => void;
	/** Persistently resume the goal loop. */
	onResume?: () => void;
	/** Persist a new / edited goal. Called with the trimmed text. */
	onSubmit: (text: string) => void;
	/** True when the persisted goal loop is paused. */
	paused?: boolean;
	/** The judge's most recent reason for its verdict. */
	reason?: string;
	/** Unix milliseconds when the goal was set; drives the elapsed timer. */
	startedAt?: number;
	/** Open in edit mode immediately (the "Pursue goal" draft flow). */
	startInEdit?: boolean;
	/** The current goal (completion condition) text. */
	text: string;
	/** How many turns the judge has evaluated. */
	turns?: number;
}

/**
 * The goal bar: a strip above the composer that surfaces the active `/goal`,
 * mirroring the info-bar treatment (rounded top, muted card). It shows the goal
 * text, a live "active for" timer, the judge's latest reason, and lets the user
 * edit or clear the goal inline.
 */
export function GoalBar({
	text,
	startedAt,
	achievedAt,
	reason,
	turns,
	judging,
	achieved,
	paused,
	startInEdit,
	onSubmit,
	onClear,
	onPause,
	onResume,
	onCancelDraft,
}: GoalBarProps) {
	const [editing, setEditing] = useState(Boolean(startInEdit));
	const [draft, setDraft] = useState(text);
	const inputRef = useRef<HTMLInputElement>(null);

	// Live elapsed timer: re-render every second while the goal is active.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (achieved || paused || !isNativeNumber(startedAt)) {
			return;
		}
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [achieved, startedAt]);

	// Keep the draft in sync when the goal text changes from outside (e.g. set via
	// the `/goal` command) and focus the field when entering edit mode.
	useEffect(() => {
		if (!editing) {
			setDraft(text);
		}
	}, [text, editing]);
	useEffect(() => {
		if (editing) {
			const el = inputRef.current;
			if (el) {
				el.focus();
				el.setSelectionRange(el.value.length, el.value.length);
			}
		}
	}, [editing]);

	const elapsedMs =
		startedAt === undefined
			? null
			: getGoalElapsedMs({ achievedAt, startedAt }, now);
	const elapsed = elapsedMs === null ? null : formatGoalElapsed(elapsedMs);

	const commit = () => {
		const trimmed = draft.trim();
		if (!trimmed) {
			// Empty draft → treat as a cancelled draft, or no-op for an existing goal.
			if (!text && onCancelDraft) {
				onCancelDraft();
			}
			setEditing(false);
			return;
		}
		onSubmit(trimmed);
		setEditing(false);
	};

	const cancel = () => {
		if (!text && onCancelDraft) {
			onCancelDraft();
		}
		setDraft(text);
		setEditing(false);
	};

	return (
		<div className="flex flex-col gap-1 rounded-t-2xl border-border border-b bg-muted px-3 py-2">
			<div className="flex items-center gap-2">
				<HugeiconsIcon
					className={cn(
						"size-4 shrink-0",
						achieved ? "text-status-success" : "text-primary"
					)}
					icon={achieved ? CheckmarkCircle02Icon : Target01Icon}
				/>
				{editing ? (
					<input
						aria-label="Goal"
						className="min-w-0 flex-1 bg-transparent text-foreground text-sm outline-none placeholder:text-muted-foreground"
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								commit();
							} else if (e.key === "Escape") {
								e.preventDefault();
								cancel();
							}
						}}
						placeholder="Describe the goal Ryu should work toward until it's done…"
						ref={inputRef}
						value={draft}
					/>
				) : (
					<button
						className="min-w-0 flex-1 truncate text-left text-foreground text-sm"
						onClick={() => setEditing(true)}
						title="Click to edit the goal"
						type="button"
					>
						<span className="font-medium">
							{achieved ? "Goal achieved" : paused ? "Goal paused" : "Goal"}
						</span>
						<span className="ml-1.5 text-muted-foreground">{text}</span>
					</button>
				)}

				<div className="flex shrink-0 items-center gap-0.5">
					{!editing && elapsed && (
						<span className="mr-1 inline-flex items-center gap-1 text-muted-foreground text-xs">
							<HugeiconsIcon className="size-3" icon={Clock01Icon} />
							{elapsed}
							{isNativeNumber(turns) && turns > 0 && (
								<span className="text-muted-foreground/70">
									· {turns} {turns === 1 ? "turn" : "turns"}
								</span>
							)}
						</span>
					)}
					{editing ? (
						<>
							<Button
								appearance="goal-save"
								aria-label="Save goal"
								onClick={commit}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={Tick02Icon} />
							</Button>
							<Button
								appearance="goal-action"
								aria-label="Cancel"
								onClick={cancel}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
							</Button>
						</>
					) : (
						<>
							{!achieved && (paused ? onResume : onPause) && (
								<Button
									appearance="goal-action"
									aria-label={paused ? "Resume goal" : "Pause goal"}
									onClick={paused ? onResume : onPause}
									size="icon"
									type="button"
									variant="ghost"
								>
									<HugeiconsIcon
										className="size-3.5"
										icon={paused ? PlayIcon : PauseIcon}
									/>
								</Button>
							)}
							<Button
								appearance="goal-action"
								aria-label="Edit goal"
								onClick={() => setEditing(true)}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={PencilEdit01Icon} />
							</Button>
							<Button
								appearance="goal-action"
								aria-label="Clear goal"
								onClick={onClear}
								size="icon"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
							</Button>
						</>
					)}
				</div>
			</div>

			{/* The judge's latest reason / live status, shown under the goal line. */}
			{!editing && (judging || reason) && (
				<p className="truncate pl-6 text-muted-foreground/70 text-xs">
					{judging ? "Judging progress…" : reason}
				</p>
			)}
		</div>
	);
}
