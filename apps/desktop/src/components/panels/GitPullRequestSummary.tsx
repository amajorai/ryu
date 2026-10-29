import { useLiteralMessages } from "@ryu/i18n/react";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	IconBrandGithub,
	IconCircleCheck,
	IconCircleX,
	IconGitMerge,
	IconGitPullRequest,
	IconGitPullRequestClosed,
	IconGitPullRequestDraft,
	IconLoader2,
	IconMessageCircle,
	IconMinus,
} from "@tabler/icons-react";
import {
	checkBucket,
	failingPullRequestChecks,
	type GitPullRequest,
	type GitPullRequestStatus,
	gitPullRequestStatus,
	gitPullRequestStatusLabel,
	type PullRequestCheck,
	pullRequestHasMergeConflicts,
} from "@/src/lib/api/pull-requests.ts";

export function GitPullRequestStatusIcon({
	pullRequest,
}: {
	pullRequest: GitPullRequest;
}) {
	const status = gitPullRequestStatus(pullRequest);
	const label = gitPullRequestStatusLabel(status);
	const className = cn("size-4 shrink-0", statusColorClass(status));
	const Icon = statusIcon(status);
	return (
		<span
			aria-label={label}
			className="inline-flex shrink-0"
			data-status={status}
			data-testid={`pull-request-status-icon-${pullRequest.number}`}
			role="img"
			title={label}
		>
			<Icon aria-hidden className={className} />
		</span>
	);
}

function statusIcon(status: GitPullRequestStatus) {
	if (status === "merged") {
		return IconGitMerge;
	}
	if (status === "closed") {
		return IconGitPullRequestClosed;
	}
	if (status === "draft") {
		return IconGitPullRequestDraft;
	}
	return IconGitPullRequest;
}

function statusColorClass(status: GitPullRequestStatus): string {
	if (status === "merged") {
		return "text-[#8250df] dark:text-[#a371f7]";
	}
	if (status === "closed") {
		return "text-[#cf222e] dark:text-[#f85149]";
	}
	if (status === "draft") {
		return "text-[#656d76] dark:text-[#8b949e]";
	}
	return "text-[#1f883d] dark:text-[#3fb950]";
}

function CheckIcon({ check }: { check: PullRequestCheck }) {
	const bucket = checkBucket(check);
	if (bucket === "pass") {
		return (
			<IconCircleCheck aria-hidden className="size-3.5 text-status-success" />
		);
	}
	if (bucket === "fail") {
		return (
			<IconCircleX aria-hidden className="size-3.5 text-status-destructive" />
		);
	}
	if (bucket === "pending") {
		return (
			<IconLoader2
				aria-hidden
				className="size-3.5 animate-spin text-status-warning"
			/>
		);
	}
	return <IconMinus aria-hidden className="size-3.5 text-muted-foreground" />;
}

function checkLabel(check: PullRequestCheck): string {
	return check.name ?? check.workflowName ?? "Unnamed check";
}

function checkSummary(pullRequest: GitPullRequest) {
	let passed = 0;
	let pending = 0;
	for (const check of pullRequest.statusCheckRollup) {
		const bucket = checkBucket(check);
		if (bucket === "pass") {
			passed += 1;
		} else if (bucket === "pending") {
			pending += 1;
		}
	}
	return {
		failed: failingPullRequestChecks(pullRequest),
		passed,
		pending,
	};
}

export function GitPullRequestSummary({
	className,
	compact = false,
	onFix,
	onFixMergeConflicts,
	pullRequest,
	showStatusIcon = true,
}: {
	className?: string;
	compact?: boolean;
	onFix?: () => void;
	onFixMergeConflicts?: () => void;
	pullRequest: GitPullRequest;
	showStatusIcon?: boolean;
}) {
	const tl = useLiteralMessages();
	const { failed, passed, pending } = checkSummary(pullRequest);
	const checkCount = pullRequest.statusCheckRollup.length;
	const hasMergeConflicts = pullRequestHasMergeConflicts(pullRequest);
	const ciLabel =
		failed.length > 0
			? tl(
					"{failedCount, plural, one {# failing check} other {# failing checks}}",
					{ failedCount: failed.length }
				)
			: pending > 0
				? tl(
						"{pendingCount, plural, one {# check running} other {# checks running}}",
						{ pendingCount: pending }
					)
				: checkCount > 0
					? tl(
							"{passedCount, plural, one {# check passed} other {# checks passed}}",
							{ passedCount: passed }
						)
					: "No checks yet";
	const ciTone =
		failed.length > 0
			? "text-status-destructive"
			: pending > 0
				? "text-status-warning"
				: checkCount > 0
					? "text-status-success"
					: "text-muted-foreground";

	return (
		<div
			className={cn("flex min-w-0 flex-col gap-1.5", className)}
			data-testid={`pull-request-summary-${pullRequest.number}`}
		>
			<a
				aria-label={tl("Open pull request: {title}", {
					title: pullRequest.title,
				})}
				className="flex min-w-0 items-center gap-1.5 text-foreground transition-colors hover:text-primary"
				href={safeHttpUrl(pullRequest.url) ?? undefined}
				rel="noopener noreferrer"
				target="_blank"
			>
				{showStatusIcon ? (
					<GitPullRequestStatusIcon pullRequest={pullRequest} />
				) : (
					<IconBrandGithub aria-hidden className="size-4 shrink-0" />
				)}
				<span
					className="min-w-0 truncate font-medium"
					title={pullRequest.title}
				>
					{pullRequest.title}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs">
					#{pullRequest.number}
				</span>
			</a>
			<div className="flex min-w-0 items-center gap-1.5 text-xs">
				<span className="shrink-0 text-muted-foreground">CI</span>
				<span className={cn("min-w-0 truncate", ciTone)} title={ciLabel}>
					{ciLabel}
				</span>
				{onFix && failed.length > 0 ? (
					<button
						className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-medium text-status-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onFix();
						}}
						type="button"
					>
						Fix
					</button>
				) : null}
			</div>
			{hasMergeConflicts ? (
				<div
					className="flex min-w-0 items-center gap-1.5 text-xs"
					data-testid={`pull-request-merge-conflicts-${pullRequest.number}`}
				>
					<IconCircleX
						aria-hidden
						className="size-3.5 shrink-0 text-status-destructive"
					/>
					<span className="min-w-0 truncate text-muted-foreground">
						Merge conflicts
					</span>
					{onFixMergeConflicts ? (
						<button
							aria-label={tl("Fix merge conflicts in pull request #{number}", {
								number: String(pullRequest.number),
							})}
							className="ml-auto shrink-0 rounded-md px-1.5 py-0.5 font-medium text-status-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onFixMergeConflicts();
							}}
							type="button"
						>
							Fix
						</button>
					) : null}
				</div>
			) : null}
			{pullRequest.commentsCount === null ? null : (
				<a
					aria-label={tl("Open {commentsCount} comments on pull request", {
						commentsCount: String(pullRequest.commentsCount),
					})}
					className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
					href={safeHttpUrl(pullRequest.url) ?? undefined}
					rel="noopener noreferrer"
					target="_blank"
				>
					<IconMessageCircle aria-hidden className="size-3.5 shrink-0" />
					<span>
						{tl(
							"{commentsCount, plural, one {{commentsLabel} comment} other {{commentsLabel} comments}}",
							{
								commentsCount: pullRequest.commentsCount,
								commentsLabel: String(pullRequest.commentsCount),
							}
						)}
					</span>
				</a>
			)}
			{!compact && checkCount > 0 ? (
				<div className="flex flex-col gap-1 border-border/60 border-t pt-1.5">
					{pullRequest.statusCheckRollup.slice(0, 6).map((check, index) => (
						<div
							className="type-caption flex min-w-0 items-center gap-1.5"
							key={`${checkLabel(check)}-${index}`}
						>
							<CheckIcon check={check} />
							<span
								className="min-w-0 truncate text-muted-foreground"
								title={checkLabel(check)}
							>
								{checkLabel(check)}
							</span>
						</div>
					))}
					{checkCount > 6 ? (
						<span className="type-compact text-muted-foreground">
							{tl("+{extraCount} more checks", {
								extraCount: String(checkCount - 6),
							})}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}
