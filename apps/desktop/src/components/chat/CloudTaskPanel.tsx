// apps/desktop/src/components/chat/CloudTaskPanel.tsx
//
// Live status strip for a locked cloud chat, rendered in the composer's
// WorkspaceBar after the Cloud picker. It projects Core's cloud task: state,
// session countdown, the managed agent's redacted output tail, and the three
// actions Core exposes — review the diff, push a branch (optionally opening a
// GitHub pull request, which Core creates), stop the session.
//
// Desktop never talks to the Box service and never holds Box or GitHub
// credentials; every action goes through Core's `/api/cloud-tasks` routes. The
// panel hides when Core has no task for this chat, or when the status route is
// missing (older Core) or unreachable.
//
// A Fresh box task runs on its own session Box with its own screen. The strip
// then also shows the Box's running cost (`$0.0123 · 18 min`, from the
// Gateway's metering tick through Core), a low-credit warning, the banner after
// the Box stopped for lack of credit (with Top up), and a View screen action
// that opens the Box screen tab next to the chat.

import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	GitBranchIcon,
	GitCompareIcon,
	LinkSquare02Icon,
	MonitorDotIcon,
	StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
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
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import {
	CLOUD_TASK_QUERY_KEY,
	useCloudTask,
} from "@/src/hooks/useCloudTask.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import {
	openSessionBoxScreen,
	useSessionBox,
} from "@/src/hooks/useSessionBox.ts";
import { ApiError, type ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudTaskDiff,
	type CloudTaskFinish,
	type CloudTaskPullRequestError,
	type CloudTaskStatus,
	fetchCloudTaskDiff,
	finishCloudTask,
	stopCloudTask,
} from "@/src/lib/api/cloud-tasks.ts";
import { CLOUD_EXECUTOR_LABELS } from "@/src/lib/cloud-task-selection.ts";
import { BoxCostChip, BoxCreditBanner } from "./BoxCostChip.tsx";

interface Props {
	conversationId: string;
	/** Called once per newly settled run or finish, so the chat reloads Core's messages. */
	onRunSettled?: () => void;
	target: ApiTarget;
}

const STATUS = {
	preparing: { label: "Preparing box", dotClass: "bg-warning" },
	ready: { label: "Ready", dotClass: "bg-success" },
	running: { label: "Running", dotClass: "bg-warning" },
	finishing: { label: "Finishing", dotClass: "bg-warning" },
	failed: { label: "Failed", dotClass: "bg-destructive" },
	stopped: { label: "Stopped", dotClass: "bg-muted-foreground/40" },
	expired: { label: "Expired", dotClass: "bg-muted-foreground/40" },
	interrupted: { label: "Interrupted", dotClass: "bg-destructive" },
} satisfies Record<
	CloudTaskStatus["state"],
	{ label: string; dotClass: string }
>;

const TERMINAL_STATES = new Set<CloudTaskStatus["state"]>([
	"failed",
	"stopped",
	"expired",
	"interrupted",
]);

const DEFAULT_COMMIT_MESSAGE = "Changes from Ryu cloud task";
const MAX_PULL_REQUEST_TITLE_CHARS = 256;
/** Core's limit, counted in Unicode code points like Core counts it. */
const MAX_PULL_REQUEST_BODY_CHARS = 65_536;
const characterCount = new Intl.NumberFormat("en-US");

function codePointLength(text: string): number {
	let count = 0;
	for (const _ of text) {
		count += 1;
	}
	return count;
}

const PULL_REQUEST_ERROR_LABELS = {
	auth: "GitHub denied access",
	already_exists: "a pull request for this branch already exists",
	validation: "GitHub rejected the request",
	network: "GitHub could not be reached",
	unknown: "unknown error",
} satisfies Record<CloudTaskPullRequestError, string>;

function pullRequestFailure(error: CloudTaskPullRequestError): string {
	return `Pull request not opened: ${PULL_REQUEST_ERROR_LABELS[error]}.`;
}

/** A readable message for a failed mutation; 403 is called out as a permission problem. */
function failureMessage(error: unknown, fallback: string): string {
	if (error instanceof ApiError) {
		const detail = error.serverMessage ?? error.message;
		return error.status === 403 ? `Permission denied: ${detail}` : detail;
	}
	return error instanceof Error ? error.message : fallback;
}

/** Why a stopped task's Box stopped, as a short suffix for the status label. */
const STOP_REASON_LABELS: Record<string, string> = {
	balance: "out of credits",
	budget: "budget reached",
	accounting: "usage not recorded",
	idle: "idle",
	ttl: "time limit",
	user: "by you",
	liveness: "lost contact",
	suspended: "billing suspended",
	restart: "node restarted",
};

function statusLabel(task: CloudTaskStatus, stopReason: string | null): string {
	if (task.state === "running") {
		return `Running ${CLOUD_EXECUTOR_LABELS[task.executor]}`;
	}
	const reason = stopReason ? STOP_REASON_LABELS[stopReason] : undefined;
	if (task.state === "stopped" && reason) {
		return `${STATUS.stopped.label} · ${reason}`;
	}
	return STATUS[task.state].label;
}

function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
	return hours > 0 ? `${hours}:${mmss}` : mmss;
}

function lastRunFailure(task: CloudTaskStatus): string | null {
	const run = task.lastRun;
	if (run?.status !== "failed") {
		return null;
	}
	if (run.reason) {
		return `Last run failed: ${run.reason.replaceAll("_", " ")}`;
	}
	return run.exitCode === null
		? "Last run failed"
		: `Last run failed (exit ${run.exitCode})`;
}

function finishKey(finish: CloudTaskFinish | null): string | null {
	return finish ? JSON.stringify(finish) : null;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const deadline = Date.parse(expiresAt);
	if (Number.isNaN(deadline)) {
		return null;
	}
	return (
		<span
			className="type-compact text-muted-foreground tabular-nums"
			title={`Session ends at ${new Date(deadline).toLocaleTimeString()}`}
		>
			{formatRemaining(deadline - now)} left
		</span>
	);
}

function DiffDialog({
	conversationId,
	onOpenChange,
	open,
	target,
}: {
	conversationId: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const [diff, setDiff] = useState<CloudTaskDiff | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		const controller = new AbortController();
		setDiff(null);
		setError(null);
		fetchCloudTaskDiff(target, conversationId, controller.signal)
			.then((result) => {
				if (!controller.signal.aborted) {
					setDiff(result);
				}
			})
			.catch((failure: unknown) => {
				if (!controller.signal.aborted) {
					setError(failureMessage(failure, "Could not load the changes."));
				}
			});
		return () => controller.abort();
	}, [conversationId, open, target]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Review changes</DialogTitle>
					<DialogDescription>
						Changes in the cloud box compared with the base commit.
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				{error || diff ? null : (
					<p className="text-muted-foreground text-sm" role="status">
						Loading changes…
					</p>
				)}
				{diff ? (
					<div className="flex min-w-0 flex-col gap-3">
						{diff.files.length === 0 ? (
							<p className="text-muted-foreground text-sm">No changes yet.</p>
						) : (
							<ul className="flex flex-col gap-1 text-sm">
								{diff.files.map((file) => (
									<li
										className="flex min-w-0 items-center gap-2"
										key={file.path}
									>
										<span
											className="min-w-0 flex-1 truncate font-mono text-xs"
											title={file.path}
										>
											{file.path}
										</span>
										<span className="type-compact text-status-success tabular-nums">
											+{file.insertions ?? "–"}
										</span>
										<span className="type-compact text-status-destructive tabular-nums">
											−{file.deletions ?? "–"}
										</span>
									</li>
								))}
							</ul>
						)}
						{diff.patch ? (
							<pre className="type-micro max-h-96 overflow-auto rounded-md bg-muted p-2 font-mono">
								{diff.patch}
							</pre>
						) : null}
						{diff.truncated ? (
							<p className="text-muted-foreground text-xs" role="status">
								The diff is too large to show in full. Push the branch to review
								the rest on GitHub.
							</p>
						) : null}
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function PushDialog({
	baseBranch,
	conversationId,
	onFinished,
	onOpenChange,
	open,
	target,
}: {
	/** The branch the task started from; pull requests target it. */
	baseBranch: string | null;
	conversationId: string;
	onFinished: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const branchId = useId();
	const messageId = useId();
	const teardownId = useId();
	const pullRequestId = useId();
	const pullRequestTitleId = useId();
	const draftId = useId();
	const pullRequestBodyId = useId();
	const pullRequestBodyHintId = useId();
	const [branch, setBranch] = useState(`ryu/${conversationId.slice(0, 8)}`);
	const [commitMessage, setCommitMessage] = useState(DEFAULT_COMMIT_MESSAGE);
	const [destroy, setDestroy] = useState(true);
	const [openPullRequest, setOpenPullRequest] = useState(false);
	const [pullRequestTitle, setPullRequestTitle] = useState("");
	const [pullRequestBody, setPullRequestBody] = useState("");
	const [draft, setDraft] = useState(false);
	const pullRequestBodyLength = codePointLength(pullRequestBody);
	const pullRequestBodyTooLong =
		pullRequestBodyLength > MAX_PULL_REQUEST_BODY_CHARS;
	const canOpenPullRequest = baseBranch !== null;
	const wantsPullRequest = canOpenPullRequest && openPullRequest;
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<CloudTaskFinish | null>(null);

	useEffect(() => {
		if (open) {
			setResult(null);
		}
	}, [open]);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (wantsPullRequest && pullRequestBodyTooLong) {
			return;
		}
		setPending(true);
		try {
			const title = pullRequestTitle.trim();
			// A blank body is omitted so Core writes its default description; any
			// other text is sent as typed, keeping its Markdown formatting.
			const prBody = pullRequestBody.trim() ? pullRequestBody : null;
			const finish = await finishCloudTask(target, conversationId, {
				push: true,
				branch: branch.trim(),
				commitMessage: commitMessage.trim() || DEFAULT_COMMIT_MESSAGE,
				teardown: destroy ? "destroy" : "keep",
				...(wantsPullRequest
					? {
							openPullRequest: true,
							draft,
							...(title ? { pullRequestTitle: title } : {}),
							...(prBody === null ? {} : { pullRequestBody: prBody }),
						}
					: {}),
			});
			setResult(finish);
			if (finish.pullRequest) {
				toast.success(`Opened pull request #${finish.pullRequest.number}`);
			} else if (finish.pushed && finish.pullRequestError) {
				toast.error(pullRequestFailure(finish.pullRequestError));
			} else if (finish.pushed) {
				toast.success(`Pushed ${finish.branch ?? "branch"}`);
			} else {
				toast.error(
					`Push failed (${finish.pushError ?? "unknown"}). The box was kept.`
				);
			}
			onFinished();
		} catch (failure) {
			toast.error(failureMessage(failure, "Could not push the branch."));
		} finally {
			setPending(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Push branch</DialogTitle>
					<DialogDescription>
						Commit the box's changes and push them to a new branch on GitHub.
					</DialogDescription>
				</DialogHeader>
				{result?.pushed ? (
					<div className="flex flex-col gap-2 text-sm" role="status">
						<p>
							Pushed {result.branch} · {result.files} files, +
							{result.insertions} −{result.deletions}
						</p>
						{result.pullRequest ? (
							<a
								className="text-primary underline-offset-4 hover:underline"
								href={result.pullRequest.url}
								rel="noopener noreferrer"
								target="_blank"
							>
								Open pull request #{result.pullRequest.number} on GitHub
							</a>
						) : null}
						{result.pullRequestError ? (
							<p className="text-status-destructive">
								{pullRequestFailure(result.pullRequestError)}
							</p>
						) : null}
						{result.compareUrl && !result.pullRequest ? (
							<a
								className="text-primary underline-offset-4 hover:underline"
								href={result.compareUrl}
								rel="noopener noreferrer"
								target="_blank"
							>
								Open the compare view on GitHub
							</a>
						) : null}
					</div>
				) : (
					<form className="flex flex-col gap-3" onSubmit={handleSubmit}>
						{result && !result.pushed ? (
							<p className="text-sm text-status-destructive" role="alert">
								Push failed ({result.pushError ?? "unknown"}). The box was kept.
							</p>
						) : null}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={branchId}>Branch</Label>
							<Input
								id={branchId}
								onChange={(event) => setBranch(event.target.value)}
								required
								value={branch}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={messageId}>Commit message</Label>
							<Input
								id={messageId}
								onChange={(event) => setCommitMessage(event.target.value)}
								value={commitMessage}
							/>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={destroy}
								id={teardownId}
								onCheckedChange={(checked) => setDestroy(checked === true)}
							/>
							<Label htmlFor={teardownId}>Remove the box after pushing</Label>
						</div>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={wantsPullRequest}
								disabled={!canOpenPullRequest}
								id={pullRequestId}
								onCheckedChange={(checked) =>
									setOpenPullRequest(checked === true)
								}
							/>
							<Label htmlFor={pullRequestId}>
								{canOpenPullRequest
									? `Open pull request into ${baseBranch}`
									: "Open pull request (needs a starting branch)"}
							</Label>
						</div>
						{wantsPullRequest ? (
							<>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={pullRequestTitleId}>Pull request title</Label>
									<Input
										id={pullRequestTitleId}
										maxLength={MAX_PULL_REQUEST_TITLE_CHARS}
										onChange={(event) =>
											setPullRequestTitle(event.target.value)
										}
										placeholder={commitMessage.trim() || DEFAULT_COMMIT_MESSAGE}
										value={pullRequestTitle}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor={pullRequestBodyId}>
										Pull request description (optional)
									</Label>
									<Textarea
										aria-describedby={pullRequestBodyHintId}
										aria-invalid={pullRequestBodyTooLong || undefined}
										className="max-h-48"
										id={pullRequestBodyId}
										onChange={(event) => setPullRequestBody(event.target.value)}
										placeholder="Describe the change. Markdown is supported."
										rows={4}
										value={pullRequestBody}
									/>
									<p
										className={
											pullRequestBodyTooLong
												? "text-status-destructive text-xs"
												: "text-muted-foreground text-xs"
										}
										id={pullRequestBodyHintId}
										role={pullRequestBodyTooLong ? "alert" : undefined}
									>
										{pullRequestBodyTooLong
											? `Too long: ${characterCount.format(pullRequestBodyLength)} of ${characterCount.format(MAX_PULL_REQUEST_BODY_CHARS)} characters. Shorten the description to push.`
											: `${characterCount.format(pullRequestBodyLength)} / ${characterCount.format(MAX_PULL_REQUEST_BODY_CHARS)} characters`}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<Checkbox
										checked={draft}
										id={draftId}
										onCheckedChange={(checked) => setDraft(checked === true)}
									/>
									<Label htmlFor={draftId}>Open as draft</Label>
								</div>
							</>
						) : null}
						<DialogFooter>
							<Button
								disabled={
									pending ||
									!branch.trim() ||
									(wantsPullRequest && pullRequestBodyTooLong)
								}
								size="sm"
								type="submit"
							>
								{pending ? "Pushing…" : "Push branch"}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

function StopDialog({
	conversationId,
	onOpenChange,
	onStopped,
	open,
	target,
}: {
	conversationId: string;
	onOpenChange: (open: boolean) => void;
	onStopped: () => void;
	open: boolean;
	target: ApiTarget;
}) {
	const [pending, setPending] = useState(false);
	const handleStop = async () => {
		setPending(true);
		try {
			await stopCloudTask(target, conversationId);
			toast.success("Cloud session stopped");
			onStopped();
			onOpenChange(false);
		} catch (failure) {
			toast.error(failureMessage(failure, "Could not stop the cloud session."));
		} finally {
			setPending(false);
		}
	};
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Stop cloud session?</DialogTitle>
					<DialogDescription>
						The agent stops and the box is removed. Changes that were not pushed
						are lost.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						onClick={() => onOpenChange(false)}
						size="sm"
						type="button"
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={pending}
						onClick={handleStop}
						size="sm"
						type="button"
						variant="destructive"
					>
						{pending ? "Stopping…" : "Stop session"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function CloudTaskPanel({
	target,
	conversationId,
	onRunSettled,
}: Props) {
	const queryClient = useQueryClient();
	const { data: task } = useCloudTask(target, conversationId, true);
	// Fresh cloud box rollout gate. When off, review/push is hidden but status and
	// Stop session stay so an already-running task can still be stopped.
	const boxBackendEnabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	// The Box's live cost and warning. The task status stops polling once the
	// task settles, so the session Box status (polled while the Box runs) keeps
	// the chip current; the task's own `box` is the fallback.
	const { data: sessionBox } = useSessionBox(
		target,
		conversationId,
		boxBackendEnabled && task?.backend === "box"
	);
	const [outputOpen, setOutputOpen] = useState(true);
	const [dialog, setDialog] = useState<"diff" | "push" | "stop" | null>(null);

	// Fire `onRunSettled` once per new lastRun id or finish object. The first
	// observed status is the baseline, so opening a chat does not reload it.
	const onRunSettledRef = useRef(onRunSettled);
	onRunSettledRef.current = onRunSettled;
	const seenRef = useRef<{
		finish: string | null;
		runId: string | null;
	} | null>(null);
	useEffect(() => {
		if (task === undefined) {
			return;
		}
		const next = {
			runId: task?.lastRun?.id ?? null,
			finish: finishKey(task?.finish ?? null),
		};
		const previous = seenRef.current;
		seenRef.current = next;
		if (!previous) {
			return;
		}
		const newRun = next.runId !== null && next.runId !== previous.runId;
		const newFinish = next.finish !== null && next.finish !== previous.finish;
		if (newRun || newFinish) {
			onRunSettledRef.current?.();
		}
	}, [task]);

	if (!task) {
		return null;
	}

	const invalidate = () => {
		Promise.resolve(
			queryClient.invalidateQueries({
				queryKey: [CLOUD_TASK_QUERY_KEY, target.url],
			})
		).catch(() => undefined);
	};

	const status = STATUS[task.state];
	const terminal = TERMINAL_STATES.has(task.state);
	const canPush =
		task.backend === "box" && task.state === "ready" && task.activeRun === null;
	const failure = lastRunFailure(task);
	const finish = task.finish;
	const box =
		boxBackendEnabled && task.backend === "box"
			? (sessionBox?.box ?? task.box)
			: null;
	const canViewScreen =
		box !== null && (box.state === "ready" || box.state === "parked");

	return (
		<section
			aria-label="Cloud task"
			className="flex w-full min-w-0 flex-col gap-1 py-0.5"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-1.5">
				<span
					aria-hidden
					className={`size-1.5 shrink-0 rounded-full ${status.dotClass}`}
				/>
				<span className="type-compact font-medium" role="status">
					{statusLabel(task, box?.stopReason ?? null)}
				</span>
				{boxBackendEnabled && task.backend === "box" ? (
					<Badge typography="micro" variant="secondary">
						Fresh box
					</Badge>
				) : null}
				{task.expiresAt && !terminal ? (
					<Countdown expiresAt={task.expiresAt} />
				) : null}
				{box ? <BoxCostChip box={box} /> : null}
				<div className="ms-auto flex items-center gap-0.5">
					{box ? (
						<Button
							disabled={!canViewScreen}
							onClick={() => openSessionBoxScreen(conversationId)}
							size="sm"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3.5" icon={MonitorDotIcon} />
							View screen
						</Button>
					) : null}
					{boxBackendEnabled ? (
						<>
							<Button
								disabled={terminal}
								onClick={() => setDialog("diff")}
								size="sm"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={GitCompareIcon} />
								Review changes
							</Button>
							<Button
								disabled={!canPush}
								onClick={() => setDialog("push")}
								size="sm"
								type="button"
								variant="ghost"
							>
								<HugeiconsIcon className="size-3.5" icon={GitBranchIcon} />
								Push branch
							</Button>
						</>
					) : null}
					{terminal ? null : (
						<Button
							onClick={() => setDialog("stop")}
							size="sm"
							type="button"
							variant="ghost"
						>
							<HugeiconsIcon className="size-3.5" icon={StopIcon} />
							{task.activeRun ? "Stop" : "Stop session"}
						</Button>
					)}
				</div>
			</div>
			{box ? <BoxCreditBanner box={box} /> : null}
			{failure ? (
				<p className="type-compact text-status-destructive">{failure}</p>
			) : null}
			{finish?.pushed ? (
				<p className="type-compact flex items-center gap-1 text-muted-foreground">
					Pushed {finish.branch} · +{finish.insertions} −{finish.deletions}
					{finish.pullRequest ? (
						<a
							className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
							href={finish.pullRequest.url}
							rel="noopener noreferrer"
							target="_blank"
						>
							Pull request #{finish.pullRequest.number}
							<HugeiconsIcon className="size-3" icon={LinkSquare02Icon} />
						</a>
					) : null}
					{finish.compareUrl && !finish.pullRequest ? (
						<a
							className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
							href={finish.compareUrl}
							rel="noopener noreferrer"
							target="_blank"
						>
							Compare
							<HugeiconsIcon className="size-3" icon={LinkSquare02Icon} />
						</a>
					) : null}
				</p>
			) : null}
			{finish?.pushed && finish.pullRequestError ? (
				<p className="type-compact text-status-destructive">
					{pullRequestFailure(finish.pullRequestError)}
				</p>
			) : null}
			{finish && !finish.pushed && finish.pushError ? (
				<p className="type-compact text-status-destructive">
					Push failed ({finish.pushError}). The box was kept.
				</p>
			) : null}
			{task.activeRun ? (
				<div className="flex min-w-0 flex-col gap-1">
					<button
						aria-expanded={outputOpen}
						className="type-compact flex items-center gap-1 self-start text-muted-foreground hover:text-foreground"
						onClick={() => setOutputOpen((open) => !open)}
						type="button"
					>
						<HugeiconsIcon
							className="size-3"
							icon={outputOpen ? ArrowDown01Icon : ArrowRight01Icon}
						/>
						Agent output
					</button>
					{outputOpen ? (
						<pre
							aria-live="polite"
							className="type-micro max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted/60 p-2 font-mono"
						>
							{task.activeRun.outputTail || "Waiting for output…"}
						</pre>
					) : null}
				</div>
			) : null}
			{boxBackendEnabled ? (
				<>
					<DiffDialog
						conversationId={conversationId}
						onOpenChange={(open) => setDialog(open ? "diff" : null)}
						open={dialog === "diff"}
						target={target}
					/>
					<PushDialog
						baseBranch={task.baseBranch}
						conversationId={conversationId}
						onFinished={invalidate}
						onOpenChange={(open) => setDialog(open ? "push" : null)}
						open={dialog === "push"}
						target={target}
					/>
				</>
			) : null}
			<StopDialog
				conversationId={conversationId}
				onOpenChange={(open) => setDialog(open ? "stop" : null)}
				onStopped={invalidate}
				open={dialog === "stop"}
				target={target}
			/>
		</section>
	);
}
