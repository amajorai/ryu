"use client";

import {
	ArrowDown01Icon,
	Cancel01Icon,
	FileEditIcon,
	GitBranchIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@ryu/ui/components/button";
import { ButtonGroup } from "@ryu/ui/components/button-group.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import { memo, useState } from "react";
import type { SuggestedTask } from "./suggested-task.ts";

export type SuggestedTaskStartMode = "chat" | "worktree";

export interface SuggestedTaskCardProps {
	/** Offer "Start in worktree" next to Start. The host decides, because only
	 *  it knows whether this chat has a project folder to branch from. */
	canStartInWorktree?: boolean;
	className?: string;
	onDismiss: (task: SuggestedTask) => void;
	/** Keep the task for later. Absent when the Drafts app is not available. */
	onSaveDraft?: (task: SuggestedTask) => Promise<void>;
	onStart: (task: SuggestedTask, mode: SuggestedTaskStartMode) => void;
	task: SuggestedTask;
}

/**
 * The "Suggested task" card above the composer: a follow-up the agent found
 * outside what it was asked to do. Styled as a card face from the Drafts table,
 * because a saved suggestion becomes one.
 *
 * Nothing here runs on its own. Start opens a NEW chat with the task's prompt,
 * and the full prompt is one click away under "Show prompt" so the user can see
 * exactly what Start will send.
 */
export const SuggestedTaskCard = memo(function SuggestedTaskCard({
	className,
	canStartInWorktree = false,
	onDismiss,
	onSaveDraft,
	onStart,
	task,
}: SuggestedTaskCardProps) {
	const [saving, setSaving] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);

	const handleSave = async () => {
		if (!onSaveDraft || saving) {
			return;
		}
		setSaving(true);
		setSaveFailed(false);
		try {
			await onSaveDraft(task);
		} catch {
			setSaveFailed(true);
		} finally {
			setSaving(false);
		}
	};

	return (
		<section
			aria-label="Suggested task"
			className={cn(
				"w-full max-w-sm rounded-xl border border-border bg-card text-card-foreground",
				className
			)}
			data-suggested-task={task.id}
		>
			<header className="flex items-center justify-between gap-2 ps-4 pe-2 pt-2">
				<span className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<HugeiconsIcon
						aria-hidden="true"
						className="size-3.5"
						icon={SparklesIcon}
					/>
					Suggested task
				</span>
				<Button
					aria-label="Dismiss suggested task"
					onClick={() => onDismiss(task)}
					size="icon-xs"
					type="button"
					variant="ghost-muted"
				>
					<HugeiconsIcon aria-hidden="true" icon={Cancel01Icon} />
				</Button>
			</header>
			<div className="px-4 pt-1">
				<h3 className="font-semibold text-sm leading-snug">{task.title}</h3>
				<p className="mt-1 line-clamp-4 text-muted-foreground text-xs leading-relaxed">
					{task.description}
				</p>
				<details className="group mt-2 text-xs">
					<summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
						Show prompt
					</summary>
					<p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-2 py-1.5 font-mono text-xs leading-relaxed">
						{task.prompt}
					</p>
				</details>
			</div>
			<footer className="flex items-center justify-end gap-2 px-4 pt-3 pb-3">
				{saveFailed ? (
					<span
						className="me-auto text-status-destructive text-xs"
						role="alert"
					>
						Could not save draft
					</span>
				) : null}
				{onSaveDraft ? (
					<Button
						disabled={saving}
						onClick={() => void handleSave()}
						size="sm"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							data-icon="inline-start"
							icon={FileEditIcon}
						/>
						{saving ? "Saving…" : "Save to Drafts"}
					</Button>
				) : null}
				{canStartInWorktree ? (
					<ButtonGroup>
						<Button
							onClick={() => onStart(task, "chat")}
							size="sm"
							type="button"
						>
							Start
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										aria-label="More ways to start"
										size="sm"
										type="button"
									>
										<HugeiconsIcon aria-hidden="true" icon={ArrowDown01Icon} />
									</Button>
								}
							/>
							<DropdownMenuContent align="end" className="min-w-48">
								<DropdownMenuItem onClick={() => onStart(task, "chat")}>
									Start in a new chat
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => onStart(task, "worktree")}>
									<HugeiconsIcon
										aria-hidden="true"
										className="size-4"
										icon={GitBranchIcon}
									/>
									Start in a worktree
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</ButtonGroup>
				) : (
					<Button onClick={() => onStart(task, "chat")} size="sm" type="button">
						Start
					</Button>
				)}
			</footer>
		</section>
	);
});
