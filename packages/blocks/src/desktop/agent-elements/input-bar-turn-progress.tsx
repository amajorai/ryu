"use client";

import {
	CheckmarkCircle02Icon,
	CircleIcon,
	Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { PatchDiff } from "@pierre/diffs/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { formatNumber } from "@ryu/ui/lib/number-format.ts";
import { cn } from "@ryu/ui/lib/utils";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { hugeiconComponent } from "./icons/hugeicon-component.tsx";
import type { InputBarTurnProgress } from "./input-bar-types.ts";

const IconCircle = hugeiconComponent(CircleIcon);
const IconCircleCheck = hugeiconComponent(CheckmarkCircle02Icon);
const IconLoader2 = hugeiconComponent(Loading03Icon);

function TurnProgressFile({
	file,
}: {
	file: InputBarTurnProgress["files"][number];
}) {
	const row = (
		<button
			className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm hover:bg-muted"
			type="button"
		>
			<FileTypeIcon className="size-4 shrink-0" path={file.path} />
			<span className="min-w-0 flex-1 truncate" title={file.path}>
				{file.path}
			</span>
			<span className="text-status-success tabular-nums">
				+{formatNumber(file.insertions)}
			</span>
			<span className="text-status-destructive tabular-nums">
				−{formatNumber(file.deletions)}
			</span>
		</button>
	);
	if (!file.preview) {
		return row;
	}
	return (
		<HoverCard>
			<HoverCardTrigger closeDelay={120} delay={160} render={row} />
			<HoverCardContent
				align="start"
				appearance="composer-preview"
				className="w-[min(42rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] overflow-hidden"
				side="top"
				sideOffset={8}
			>
				<div className="mb-1 px-2 py-1 font-mono text-muted-foreground text-xs">
					{file.path}
				</div>
				<div className="max-h-[28rem] overflow-auto rounded-xl border border-border bg-background/60">
					<PatchDiff
						disableWorkerPool
						options={{
							diffStyle: "unified",
							lineHoverHighlight: "line",
						}}
						patch={file.preview}
					/>
				</div>
			</HoverCardContent>
		</HoverCard>
	);
}

/** Live todo steps and changed-files pills shown above the composer. */
export function InputBarTurnProgressStrip({
	effectiveChangeSummary,
	reduceMotion,
	showChangeSummary,
	turnProgress,
}: {
	effectiveChangeSummary?: {
		files: number;
		insertions: number;
		deletions: number;
	};
	reduceMotion: boolean;
	showChangeSummary: boolean;
	turnProgress?: InputBarTurnProgress;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			aria-live="polite"
			className="type-detail mb-2 flex flex-wrap items-center justify-center gap-1.5"
		>
			{turnProgress?.todos ? (
				<Popover>
					<PopoverTrigger
						render={
							<button
								className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground hover:duration-0"
								data-testid="turn-progress-steps"
								type="button"
							/>
						}
					>
						<HugeiconsIcon
							className="size-3.5 text-primary"
							icon={Loading03Icon}
						/>
						<span className="tabular-nums">
							{tl("Step {current} of {total}", {
								current: String(turnProgress.todos.current),
								total: String(turnProgress.todos.total),
							})}
						</span>
					</PopoverTrigger>
					<PopoverContent
						align="center"
						className="max-h-80 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
						corners="rounded"
						side="top"
						sideOffset={8}
						spacing="menu"
					>
						{turnProgress.todos.items.map((item, index) => {
							const TodoIcon =
								item.status === "completed"
									? IconCircleCheck
									: item.status === "in_progress"
										? IconLoader2
										: IconCircle;
							return (
								<div
									className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm"
									key={`${index}-${item.label}`}
								>
									<TodoIcon
										className={cn(
											"mt-0.5 size-4 shrink-0",
											item.status === "in_progress" &&
												cn("text-primary", !reduceMotion && "animate-spin")
										)}
									/>
									<span>{item.label}</span>
								</div>
							);
						})}
					</PopoverContent>
				</Popover>
			) : null}
			{showChangeSummary && effectiveChangeSummary ? (
				<Popover>
					<PopoverTrigger
						render={
							<button
								className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3 text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground hover:duration-0"
								data-testid="turn-progress-files"
								type="button"
							/>
						}
					>
						<span>
							{tl(
								"{count, plural, one {{countText} file changed} other {{countText} files changed}}",
								{
									count: effectiveChangeSummary.files,
									countText: formatNumber(effectiveChangeSummary.files),
								}
							)}
						</span>
						<span className="font-medium text-status-success tabular-nums">
							+{formatNumber(effectiveChangeSummary.insertions)}
						</span>
						<span className="font-medium text-status-destructive tabular-nums">
							-{formatNumber(effectiveChangeSummary.deletions)}
						</span>
					</PopoverTrigger>
					{turnProgress?.files.length ? (
						<PopoverContent
							align="center"
							className="max-h-80 w-[min(24rem,calc(100vw-2rem))] overflow-y-auto"
							corners="rounded"
							side="top"
							sideOffset={8}
							spacing="dense-menu"
						>
							{turnProgress.files.map((file) => (
								<TurnProgressFile file={file} key={file.path} />
							))}
						</PopoverContent>
					) : null}
				</Popover>
			) : null}
		</div>
	);
}

/** Changed-files totals for the strip, preferring live turn progress. */
export function deriveTurnProgressSummary(
	turnProgress: InputBarTurnProgress | undefined,
	changeSummary:
		| {
				files: number;
				insertions: number;
				deletions: number;
		  }
		| undefined
) {
	const effectiveChangeSummary = turnProgress
		? {
				files: turnProgress.files.length,
				insertions: turnProgress.insertions,
				deletions: turnProgress.deletions,
			}
		: changeSummary;
	const showChangeSummary = Boolean(
		effectiveChangeSummary &&
			(effectiveChangeSummary.files > 0 ||
				effectiveChangeSummary.insertions > 0 ||
				effectiveChangeSummary.deletions > 0)
	);
	const showTurnProgress = showChangeSummary || Boolean(turnProgress?.todos);
	return { effectiveChangeSummary, showChangeSummary, showTurnProgress };
}
