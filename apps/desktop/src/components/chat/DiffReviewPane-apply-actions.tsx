// apps/desktop/src/components/chat/DiffReviewPane-apply-actions.tsx
//
// Apply (merge) / Open PR actions and their result states for the run diff
// review pane.

import {
	AlertCircleIcon,
	CheckmarkCircle02Icon,
	GitMergeIcon,
	Loading01Icon,
	Share08Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Button } from "@ryu/ui/components/button.tsx";

// ── Apply state ───────────────────────────────────────────────────────────────

export type ApplyState =
	| { status: "idle" }
	| { status: "loading"; mode: "merge" | "pr" }
	| { status: "merged"; commit: string | null }
	| { status: "pr"; prUrl: string }
	| { status: "conflict"; conflictedFiles: string[] }
	| { status: "error"; message: string };

// ── Apply / Open PR actions ───────────────────────────────────────────────────

export function DiffReviewApplyActions({
	applied,
	applyState,
	handleApply,
	setApplyState,
}: {
	applied: boolean;
	applyState: ApplyState;
	handleApply: (mode: "merge" | "pr") => Promise<void>;
	setApplyState: (state: ApplyState) => void;
}) {
	const tl = useLiteralMessages();
	const tlRich = useRichLiteralMessages();
	return (
		<div className="flex min-h-10 flex-col justify-center gap-1.5 border-border border-t px-3 py-2">
			{applyState.status === "idle" && (
				<div className="flex items-center gap-2">
					<Button onClick={() => handleApply("merge")} size="sm" variant="mono">
						<HugeiconsIcon aria-hidden className="size-4" icon={GitMergeIcon} />
						Apply (merge)
					</Button>
					<Button
						onClick={() => handleApply("pr")}
						size="sm"
						variant="ghost-muted"
					>
						<HugeiconsIcon aria-hidden className="size-4" icon={Share08Icon} />
						Open PR
					</Button>
				</div>
			)}

			{applyState.status === "loading" && (
				<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<HugeiconsIcon
						aria-hidden
						className="size-3.5 animate-spin"
						icon={Loading01Icon}
					/>
					{applyState.mode === "merge" ? "Merging…" : "Opening PR…"}
				</div>
			)}

			{applyState.status === "merged" && (
				<div className="flex items-center gap-1.5 text-status-success text-xs">
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={CheckmarkCircle02Icon}
					/>
					{applyState.commit
						? tlRich(
								"Merged<commit>{commit}</commit>",
								{ commit: applyState.commit.slice(0, 8) },
								{
									commit: (chunks) => (
										<span className="font-mono text-muted-foreground">
											{chunks}
										</span>
									),
								}
							)
						: tl("Merged")}
				</div>
			)}

			{applyState.status === "pr" && (
				<div className="flex items-center gap-1.5 text-xs">
					<HugeiconsIcon
						aria-hidden
						className="size-3.5 text-status-success"
						icon={CheckmarkCircle02Icon}
					/>
					<a
						className="truncate text-primary underline underline-offset-2"
						href={safeHttpUrl(applyState.prUrl) ?? undefined}
						rel="noopener noreferrer"
						target="_blank"
						title={applyState.prUrl}
					>
						{applyState.prUrl}
					</a>
				</div>
			)}

			{applyState.status === "conflict" && (
				<div className="flex flex-col gap-1 text-xs">
					<div className="flex items-center gap-1.5 text-status-warning">
						<HugeiconsIcon
							aria-hidden
							className="size-3.5"
							icon={AlertCircleIcon}
						/>
						Merge conflict — worktree cleaned up safely
					</div>
					{applyState.conflictedFiles.length > 0 && (
						<ul className="ml-4 list-disc font-mono text-muted-foreground">
							{applyState.conflictedFiles.map((f: string) => (
								<li key={f}>{f}</li>
							))}
						</ul>
					)}
				</div>
			)}

			{applyState.status === "error" && (
				<div className="flex items-center gap-1.5 text-status-destructive text-xs">
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={AlertCircleIcon}
					/>
					{applyState.message}
					{!applied && (
						<button
							className="ml-1 underline underline-offset-2"
							onClick={() => setApplyState({ status: "idle" })}
							type="button"
						>
							Retry
						</button>
					)}
				</div>
			)}
		</div>
	);
}
