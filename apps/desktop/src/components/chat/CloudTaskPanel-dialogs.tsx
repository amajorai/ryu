// apps/desktop/src/components/chat/CloudTaskPanel-dialogs.tsx
//
// The cloud task panel's session countdown, review-changes dialog, and stop
// dialog.

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { useEffect, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudTaskDiff,
	fetchCloudTaskDiff,
	stopCloudTask,
} from "@/src/lib/api/cloud-tasks.ts";
import { failureMessage, formatRemaining } from "./CloudTaskPanel-labels.ts";

export function Countdown({ expiresAt }: { expiresAt: string }) {
	const tl = useLiteralMessages();
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
			className="text-muted-foreground text-xs tabular-nums"
			title={tl("Session ends at {time}", {
				time: new Date(deadline).toLocaleTimeString(),
			})}
		>
			{tl("{remaining} left", { remaining: formatRemaining(deadline - now) })}
		</span>
	);
}

export function DiffDialog({
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
	const tl = useLiteralMessages();
	// `tl` is a fresh function each render; read it through a ref so the fetch
	// effect does not rerun on every render.
	const tlRef = useRef(tl);
	tlRef.current = tl;
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
					setError(
						failureMessage(
							failure,
							"Could not load the changes.",
							tlRef.current
						)
					);
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
										<span className="text-status-success text-xs tabular-nums">
											+{file.insertions ?? "–"}
										</span>
										<span className="text-status-destructive text-xs tabular-nums">
											−{file.deletions ?? "–"}
										</span>
									</li>
								))}
							</ul>
						)}
						{diff.patch ? (
							<pre className="max-h-96 overflow-auto rounded-lg bg-muted p-2 font-mono text-xs">
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

export function StopDialog({
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
	const tl = useLiteralMessages();
	const [pending, setPending] = useState(false);
	const handleStop = async () => {
		setPending(true);
		try {
			await stopCloudTask(target, conversationId);
			toast.success("Cloud session stopped");
			onStopped();
			onOpenChange(false);
		} catch (failure) {
			toast.error(
				failureMessage(failure, "Could not stop the cloud session.", tl)
			);
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
