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
import { useLiteralMessages } from "@ryu/i18n/react";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
	CLOUD_TASK_QUERY_KEY,
	useCloudTask,
} from "@/src/hooks/useCloudTask.ts";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import {
	openSessionBoxScreen,
	useSessionBox,
} from "@/src/hooks/useSessionBox.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { BoxCostChip, BoxCreditBanner } from "./BoxCostChip.tsx";
import {
	Countdown,
	DiffDialog,
	StopDialog,
} from "./CloudTaskPanel-dialogs.tsx";
import {
	finishKey,
	lastRunFailure,
	pullRequestFailure,
	STATUS,
	statusLabel,
	TERMINAL_STATES,
} from "./CloudTaskPanel-labels.ts";
import { PushDialog } from "./CloudTaskPanel-push-dialog.tsx";

interface Props {
	conversationId: string;
	/** Called once per newly settled run or finish, so the chat reloads Core's messages. */
	onRunSettled?: () => void;
	target: ApiTarget;
}

export function CloudTaskPanel({
	target,
	conversationId,
	onRunSettled,
}: Props) {
	const tl = useLiteralMessages();
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
				<span className="font-medium text-xs" role="status">
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
				<p className="text-status-destructive text-xs">{failure}</p>
			) : null}
			{finish?.pushed ? (
				<p className="flex items-center gap-1 text-muted-foreground text-xs">
					{tl("Pushed {branch} · +{insertions} −{deletions}", {
						branch: finish.branch ?? "",
						insertions: String(finish.insertions),
						deletions: String(finish.deletions),
					})}
					{finish.pullRequest ? (
						<a
							className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
							href={finish.pullRequest.url}
							rel="noopener noreferrer"
							target="_blank"
						>
							{tl("Pull request #{number}", {
								number: String(finish.pullRequest.number),
							})}
							<HugeiconsIcon className="size-3.5" icon={LinkSquare02Icon} />
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
							<HugeiconsIcon className="size-3.5" icon={LinkSquare02Icon} />
						</a>
					) : null}
				</p>
			) : null}
			{finish?.pushed && finish.pullRequestError ? (
				<p className="text-status-destructive text-xs">
					{pullRequestFailure(finish.pullRequestError)}
				</p>
			) : null}
			{finish && !finish.pushed && finish.pushError ? (
				<p className="text-status-destructive text-xs">
					{tl("Push failed ({error}). The box was kept.", {
						error: finish.pushError,
					})}
				</p>
			) : null}
			{task.activeRun ? (
				<div className="flex min-w-0 flex-col gap-1">
					<button
						aria-expanded={outputOpen}
						className="flex items-center gap-1 self-start text-muted-foreground text-xs hover:text-foreground"
						onClick={() => setOutputOpen((open) => !open)}
						type="button"
					>
						<HugeiconsIcon
							className="size-3.5"
							icon={outputOpen ? ArrowDown01Icon : ArrowRight01Icon}
						/>
						Agent output
					</button>
					{outputOpen ? (
						<pre
							aria-live="polite"
							className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 font-mono text-xs"
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
