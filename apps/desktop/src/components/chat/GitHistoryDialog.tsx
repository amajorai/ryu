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
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type GitHistoryEntry,
	importGitHistory,
	listGitHistory,
	type PortableHistoryTranscript,
	readGitHistory,
	syncGitHistory,
} from "@/src/lib/api/conversation-history.ts";

export function GitHistoryDialog({
	cwd,
	onImported,
	onOpenChange,
	open,
	target,
}: {
	cwd: string;
	onImported: (conversationId: string) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [entries, setEntries] = useState<GitHistoryEntry[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [transcript, setTranscript] =
		useState<PortableHistoryTranscript | null>(null);
	const [loading, setLoading] = useState(false);
	const [reading, setReading] = useState(false);
	const [working, setWorking] = useState(false);
	// A skipped-checkpoint notice is kept as data so it is worded at render time.
	const [error, setError] = useState<string | { skipped: number } | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const result = await listGitHistory(target, cwd);
			setEntries(result.entries);
			if (result.skipped > 0) {
				setError({ skipped: result.skipped });
			}
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not list Git conversation history."
			);
		} finally {
			setLoading(false);
		}
	}, [cwd, target]);

	useEffect(() => {
		if (open) {
			setSelectedId(null);
			setTranscript(null);
			void load();
		}
	}, [load, open]);

	const select = async (checkpointId: string) => {
		setSelectedId(checkpointId);
		setTranscript(null);
		setReading(true);
		setError(null);
		try {
			const result = await readGitHistory(target, cwd, checkpointId);
			setTranscript(result.transcript);
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not read the selected checkpoint."
			);
		} finally {
			setReading(false);
		}
	};

	const fetchFromOrigin = async () => {
		setWorking(true);
		setError(null);
		try {
			await syncGitHistory(target, cwd, "fetch");
			await load();
			toast.success("Conversation history fetched from origin");
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not fetch Git history."
			);
		} finally {
			setWorking(false);
		}
	};

	const restore = async () => {
		if (!(selectedId && transcript)) {
			return;
		}
		setWorking(true);
		setError(null);
		try {
			const result = await importGitHistory(target, cwd, selectedId);
			toast.success(
				result.messagesAdded > 0
					? "Conversation restored from Git"
					: "Conversation is already restored"
			);
			onOpenChange(false);
			onImported(result.conversationId);
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "Could not restore the conversation."
			);
		} finally {
			setWorking(false);
		}
	};

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent appearance="git-history" data-testid="git-history-dialog">
				<DialogHeader purpose="records-panel">
					<DialogTitle>Git conversation history</DialogTitle>
					<DialogDescription>
						Restore a redacted conversation checkpoint saved with this project.
					</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 space-y-4 overflow-y-auto px-6 py-5">
					<div className="flex flex-wrap items-center gap-2">
						<Button
							disabled={loading || working}
							onClick={() => void fetchFromOrigin()}
							size="sm"
							variant="outline"
						>
							Fetch history from origin
						</Button>
						<Button
							disabled={loading || working}
							onClick={() => void load()}
							size="sm"
							variant="ghost"
						>
							Refresh
						</Button>
					</div>
					{error ? (
						<p className="text-status-destructive text-xs" role="alert">
							{typeof error === "string"
								? error
								: tl("{skipped} unreadable checkpoints were skipped.", {
										skipped: String(error.skipped),
									})}
						</p>
					) : null}
					{loading ? (
						<p className="flex items-center gap-2 text-muted-foreground text-sm">
							<Spinner /> Reading Git checkpoints…
						</p>
					) : entries.length === 0 ? (
						<div className="rounded-xl border border-dashed p-5 text-center text-muted-foreground text-sm">
							No saved conversations in this repository. Fetch from origin if
							someone shared its history refs.
						</div>
					) : (
						<div className="grid gap-4 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
							<div className="max-h-80 space-y-2 overflow-y-auto">
								{entries.map((entry) => (
									<button
										aria-pressed={selectedId === entry.checkpointId}
										className={`w-full rounded-xl border p-3 text-left transition-colors hover:bg-muted/50 ${
											selectedId === entry.checkpointId
												? "border-primary bg-primary/5"
												: "border-border"
										}`}
										key={entry.checkpointId}
										onClick={() => void select(entry.checkpointId)}
										type="button"
									>
										<span
											className="block truncate font-medium text-sm"
											title={entry.title}
										>
											{entry.title}
										</span>
										<span className="mt-1 block text-muted-foreground text-xs">
											{tl("{messageCount} messages · commit {commit}", {
												messageCount: String(entry.messageCount),
												commit: entry.codeCommit.slice(0, 8),
											})}
										</span>
									</button>
								))}
							</div>
							<div className="min-h-40 rounded-xl border bg-muted/20 p-3">
								{reading ? (
									<p className="flex items-center gap-2 text-muted-foreground text-sm">
										<Spinner /> Loading transcript…
									</p>
								) : transcript ? (
									<div className="space-y-3">
										<p className="font-medium text-sm">{transcript.title}</p>
										<p className="text-muted-foreground text-xs">
											{tl(
												"{messageCount} text messages · {omittedCount} structured parts omitted",
												{
													messageCount: String(transcript.messages.length),
													omittedCount: String(
														transcript.omittedStructuredParts
													),
												}
											)}
										</p>
										<div
											className="max-h-56 space-y-2 overflow-y-auto text-xs"
											data-testid="git-history-transcript"
										>
											{transcript.messages.map((message) => (
												<div key={message.id}>
													<p className="font-medium capitalize">
														{message.role}
													</p>
													<p className="whitespace-pre-wrap break-words text-muted-foreground">
														{message.content}
													</p>
												</div>
											))}
										</div>
									</div>
								) : (
									<p className="text-muted-foreground text-sm">
										Select a checkpoint to review it before restoring.
									</p>
								)}
							</div>
						</div>
					)}
				</div>
				<DialogFooter purpose="panel-actions">
					<Button onClick={() => onOpenChange(false)} variant="ghost">
						Close
					</Button>
					<Button
						disabled={!transcript || reading || working}
						onClick={() => void restore()}
					>
						{working ? <Spinner className="mr-2" /> : null}
						Restore conversation
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
