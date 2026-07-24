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

import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Checkbox } from "@ryu/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { ScrollArea } from "@ryu/ui/components/scroll-area";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select";
import { Spinner } from "@ryu/ui/components/spinner";
import { useCallback, useEffect, useState } from "react";
import { AgentLogo, engineForAgent } from "@/src/lib/agent-logos.tsx";
import {
	importAgentThread,
	listAgentThreads,
	type NativeThread,
} from "@/src/lib/api/agent-threads.ts";
import type { AgentSummary } from "@/src/lib/api/agents.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { compactAge } from "@/src/lib/time.ts";

/** Engines whose native history Core can read — used only to pick a sensible
 * default agent. The endpoint's `supported` flag is the real authority. */
const HISTORY_ENGINE_HINT = /claude|codex/i;

function agentSupportsHistoryHint(agent: AgentSummary): boolean {
	const engine = engineForAgent(agent) ?? agent.id;
	return HISTORY_ENGINE_HINT.test(engine);
}

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
	const [agentId, setAgentId] = useState<string | null>(null);
	const [threads, setThreads] = useState<NativeThread[]>([]);
	const [supported, setSupported] = useState(true);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [importing, setImporting] = useState(false);

	// Default the picker to the first agent whose engine plausibly has importable
	// history (Claude Code / Codex), else the first agent — so the dialog opens on
	// something useful rather than an empty state.
	useEffect(() => {
		if (!open || agentId || agents.length === 0) {
			return;
		}
		const preferred = agents.find(agentSupportsHistoryHint) ?? agents[0];
		setAgentId(preferred.id);
	}, [open, agentId, agents]);

	const loadThreads = useCallback(
		async (id: string) => {
			setLoading(true);
			setError(null);
			setSelected(new Set());
			try {
				const result = await listAgentThreads(target, id);
				setSupported(result.supported);
				setThreads(result.threads);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to load threads");
				setThreads([]);
			} finally {
				setLoading(false);
			}
		},
		[target]
	);

	useEffect(() => {
		if (open && agentId) {
			loadThreads(agentId).catch(() => undefined);
		}
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
		if (!agentId || importing || selected.size === 0) {
			return;
		}
		setImporting(true);
		setError(null);
		let firstConversationId: string | null = null;
		let failed = 0;
		for (const thread of threads) {
			if (!selected.has(thread.id)) {
				continue;
			}
			try {
				const result = await importAgentThread(target, agentId, thread.id);
				firstConversationId ??= result.conversationId;
			} catch {
				failed += 1;
			}
		}
		setImporting(false);
		if (firstConversationId) {
			onImported(firstConversationId);
			onOpenChange(false);
			return;
		}
		setError(
			failed === 1
				? "Failed to import thread"
				: `Failed to import ${failed} threads`
		);
	}, [agentId, importing, selected, threads, target, onImported, onOpenChange]);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>Import a thread</DialogTitle>
					<DialogDescription>
						Bring a past conversation from an agent's own history (Claude Code,
						Codex) into Ryu — including threads you started in the terminal.
					</DialogDescription>
				</DialogHeader>

				<Select onValueChange={setAgentId} value={agentId ?? undefined}>
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
										<AgentLogo
											className="size-4 shrink-0 object-contain"
											engine={engineForAgent(selected)}
											size="16px"
										/>
										<span className="truncate">{selected.name}</span>
									</>
								);
							}}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{agents.map((agent) => (
							<SelectItem key={agent.id} value={agent.id}>
								<span className="flex items-center gap-2">
									<AgentLogo
										className="size-4 shrink-0 object-contain"
										engine={engineForAgent(agent)}
										size="16px"
									/>
									{agent.name}
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				{error && (
					<p className="rounded-md bg-destructive/10 px-3 py-2 text-destructive text-sm">
						{error}
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
							{selected.size} of {threads.length} selected
						</span>
					</div>
				)}

				{/* min-w-0 keeps a long thread path/URL from forcing the dialog's grid
				    track wider than the popup — the row text truncates instead. */}
				<ScrollArea className="h-72 min-w-0">
					{loading ? (
						<div className="flex h-72 items-center justify-center">
							<Spinner />
						</div>
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
												<span className="truncate font-medium text-foreground text-sm">
													{thread.title}
												</span>
												<span className="truncate text-muted-foreground text-xs">
													{thread.cwd ?? "—"}
												</span>
											</span>
											<span className="flex shrink-0 items-center gap-2">
												<Badge className="tabular-nums" variant="secondary">
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
						disabled={selected.size === 0 || importing}
						onClick={handleImportSelected}
					>
						{importing && <Spinner className="size-3" />}
						{selected.size > 0 ? `Import ${selected.size}` : "Import"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
