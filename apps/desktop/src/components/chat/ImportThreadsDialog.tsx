// apps/desktop/src/components/chat/ImportThreadsDialog.tsx
//
// Import a past thread from an agent's OWN on-disk history store (Claude Code /
// Codex) into a Ryu conversation — parity with how Zed imports and VS Code
// auto-surfaces the agent's past threads. Pick an agent, browse the threads Core
// found in that agent's native transcript store, click one to import it into a
// fresh Ryu conversation, and open it like any other chat.
//
// Read-only + additive: importing materializes the transcript as conversation
// messages; it never touches the agent's own history files.

import { useLiteralMessages } from "@ryu/i18n/react";
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
import { ScrollArea } from "@ryu/ui/components/scroll-area.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentSupportsHistoryHint } from "@/src/lib/agent-history.ts";
import { AgentAvatar, engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	importAgentThread,
	listAgentThreads,
	type NativeThread,
} from "@/src/lib/api/agent-threads.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { compactAge } from "@/src/lib/time.ts";

export function ImportThreadsDialog({
	open,
	onOpenChange,
	agents,
	target,
	onImported,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	agents: AgentSummary[];
	target: ApiTarget;
	/** Called with the new Ryu conversation id after a successful import. */
	onImported: (conversationId: string) => void;
}) {
	const tl = useLiteralMessages();
	const { url, token, userJwt } = target;
	const queryTarget = useMemo(
		() => ({ url, token, userJwt }),
		[url, token, userJwt]
	);
	const [agentId, setAgentId] = useState<string | null>(null);
	const [threads, setThreads] = useState<NativeThread[]>([]);
	const [supported, setSupported] = useState(true);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [importing, setImporting] = useState(false);
	const listRequest = useRef(0);
	const importLock = useRef(false);
	const firstImported = useRef<string | null>(null);
	const [importedCount, setImportedCount] = useState(0);

	// Default the picker to the first agent whose engine plausibly has importable
	// history (Claude Code / Codex), else the first agent — so the dialog opens on
	// something useful rather than an empty state.
	useEffect(() => {
		if (
			!open ||
			agents.some((agent) => agent.id === agentId) ||
			agents.length === 0
		) {
			return;
		}
		const preferred = agents.find(agentSupportsHistoryHint) ?? agents[0];
		setAgentId(preferred.id);
	}, [open, agentId, agents]);

	const loadThreads = useCallback(
		async (id: string) => {
			const request = ++listRequest.current;
			setLoading(true);
			setError(null);
			setSelected(new Set());
			firstImported.current = null;
			setImportedCount(0);
			try {
				const result = await listAgentThreads(queryTarget, id);
				if (request !== listRequest.current) {
					return;
				}
				setSupported(result.supported);
				setThreads(result.threads);
			} catch (e) {
				if (request !== listRequest.current) {
					return;
				}
				setError(e instanceof Error ? e.message : "Failed to load threads");
				setThreads([]);
			} finally {
				if (request === listRequest.current) {
					setLoading(false);
				}
			}
		},
		[queryTarget]
	);

	useEffect(() => {
		if (open && agentId) {
			loadThreads(agentId).catch(() => undefined);
		}
		return () => {
			listRequest.current += 1;
		};
	}, [open, agentId, loadThreads]);

	const toggleThread = useCallback((id: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const allSelected = threads.length > 0 && selected.size === threads.length;

	const toggleAll = useCallback(() => {
		setSelected((prev) =>
			prev.size === threads.length
				? new Set()
				: new Set(threads.map((t) => t.id))
		);
	}, [threads]);

	// Import every checked thread. One failure must not discard the successes, so
	// failures are counted and reported while the rest still land.
	const handleImportSelected = useCallback(async () => {
		if (!agentId || loading || importLock.current || selected.size === 0) {
			return;
		}
		importLock.current = true;
		const request = listRequest.current;
		setImporting(true);
		setError(null);
		const failed = new Set<string>();
		let succeeded = 0;
		for (const thread of threads) {
			if (!selected.has(thread.id)) {
				continue;
			}
			try {
				const result = await importAgentThread(target, agentId, thread.id);
				if (request !== listRequest.current) {
					break;
				}
				if (!result.conversationId || result.dryRun) {
					throw new Error("Thread import did not create a conversation");
				}
				firstImported.current ??= result.conversationId;
				succeeded += 1;
			} catch {
				if (request !== listRequest.current) {
					break;
				}
				failed.add(thread.id);
			}
		}
		importLock.current = false;
		setImporting(false);
		if (request !== listRequest.current) {
			return;
		}
		setImportedCount((count) => count + succeeded);
		setSelected(failed);
		if (failed.size > 0) {
			setThreads((previous) =>
				previous.filter(
					(thread) => !selected.has(thread.id) || failed.has(thread.id)
				)
			);
			setError(
				failed.size === 1
					? "Failed to import thread. Retry the selected thread."
					: tl(
							"Failed to import {failedCount} threads. Retry the selected threads.",
							{ failedCount: String(failed.size) }
						)
			);
			return;
		}
		if (firstImported.current) {
			onImported(firstImported.current);
			onOpenChange(false);
		}
	}, [
		agentId,
		loading,
		importing,
		selected,
		threads,
		target,
		onImported,
		onOpenChange,
		tl,
	]);

	return (
		<Dialog
			onOpenChange={(nextOpen) => {
				if (!importing) {
					onOpenChange(nextOpen);
				}
			}}
			open={open}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Import a thread</DialogTitle>
					<DialogDescription>
						Bring a past conversation from an agent's own history (Claude Code,
						Codex) into Ryu — including threads you started in the terminal.
					</DialogDescription>
				</DialogHeader>

				<Select
					disabled={importing}
					onValueChange={setAgentId}
					value={agentId ?? undefined}
				>
					<SelectTrigger aria-label="Select agent" className="w-full">
						{/* Render the selected agent's logo + name (as in the dropdown),
						    not the raw value id. */}
						<SelectValue placeholder="Select an agent">
							{(value) => {
								const selected = agents.find((a) => a.id === value);
								if (!selected) {
									return "Select an agent";
								}
								return (
									<>
										<AgentAvatar
											className="size-4 shrink-0 object-contain"
											engine={engineForAgent(selected)}
											glyph={selected.avatarGlyph}
											size="16px"
										/>
										<span className="truncate" title={selected.name}>
											{selected.name}
										</span>
									</>
								);
							}}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{agents.map((agent) => (
							<SelectItem key={agent.id} value={agent.id}>
								<span className="flex items-center gap-2">
									<AgentAvatar
										className="size-4 shrink-0 object-contain"
										engine={engineForAgent(agent)}
										glyph={agent.avatarGlyph}
										size="16px"
									/>
									{agent.name}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				{error && (
					<p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-status-destructive">
						{error}
					</p>
				)}

				{error && threads.length === 0 && agentId && (
					<Button
						disabled={loading}
						onClick={() => loadThreads(agentId)}
						variant="outline"
					>
						Retry
					</Button>
				)}
				{importedCount > 0 && (
					<p className="text-muted-foreground text-sm" role="status">
						{tl(
							"{importedCount} imported. Failed threads remain selected for retry.",
							{ importedCount: String(importedCount) }
						)}
					</p>
				)}

				{!loading && supported && threads.length > 0 && (
					<div className="flex items-center justify-between px-1">
						<button
							className="flex items-center gap-2.5 rounded-lg py-1 text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
							disabled={importing}
							onClick={toggleAll}
							type="button"
						>
							<Checkbox
								checked={allSelected}
								className="pointer-events-none shrink-0"
								tabIndex={-1}
							/>
							{allSelected ? "Deselect all" : "Select all"}
						</button>
						<span className="text-muted-foreground text-xs tabular-nums">
							{tl("{selectedCount} of {totalCount} selected", {
								selectedCount: String(selected.size),
								totalCount: String(threads.length),
							})}
						</span>
					</div>
				)}

				{/* min-w-0 keeps a long thread path/URL from forcing the dialog's grid
				    track wider than the popup — the row text truncates instead. */}
				<ScrollArea className="h-72 min-w-0">
					{loading ? (
						<SkeletonRows spacing="spacious" />
					) : supported ? (
						threads.length === 0 ? (
							<p className="rounded-xl border border-border border-dashed px-3 py-8 text-center text-muted-foreground text-sm">
								No past threads found for this agent.
							</p>
						) : (
							<ul className="flex flex-col gap-0.5 pr-2">
								{threads.map((thread) => (
									<li key={thread.id}>
										<button
											aria-pressed={selected.has(thread.id)}
											className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
											disabled={importing}
											onClick={() => toggleThread(thread.id)}
											type="button"
										>
											{/* Presentational: the row button owns the toggle, so the
											    checkbox must not be a second tab stop. */}
											<Checkbox
												checked={selected.has(thread.id)}
												className="pointer-events-none shrink-0"
												tabIndex={-1}
											/>
											<span className="flex min-w-0 flex-1 flex-col gap-0.5">
												<span
													className="truncate font-medium text-foreground text-sm"
													title={thread.title}
												>
													{thread.title}
												</span>
												<span
													className="truncate text-muted-foreground text-xs"
													title={thread.cwd ?? "—"}
												>
													{thread.cwd ?? "—"}
												</span>
											</span>
											<span className="flex shrink-0 items-center gap-2">
												<Badge typography="tabular" variant="secondary">
													{thread.messageCount}
												</Badge>
												<span className="text-muted-foreground text-xs">
													{compactAge(thread.updatedAt)}
												</span>
											</span>
										</button>
									</li>
								))}
							</ul>
						)
					) : (
						<p className="rounded-xl border border-border border-dashed px-3 py-8 text-center text-muted-foreground text-sm">
							This agent doesn't keep an importable local history.
						</p>
					)}
				</ScrollArea>

				<DialogFooter>
					<Button
						disabled={importing}
						onClick={() => onOpenChange(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={loading || selected.size === 0}
						loading={importing}
						onClick={handleImportSelected}
					>
						{selected.size > 0
							? tl("Import {selectedCount}", {
									selectedCount: String(selected.size),
								})
							: "Import"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
