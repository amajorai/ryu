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
import {
	Dialog,
	DialogContent,
	DialogDescription,
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
	const [importingId, setImportingId] = useState<string | null>(null);

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

	const handleImport = useCallback(
		async (thread: NativeThread) => {
			if (!agentId || importingId) {
				return;
			}
			setImportingId(thread.id);
			setError(null);
			try {
				const result = await importAgentThread(target, agentId, thread.id);
				onImported(result.conversationId);
				onOpenChange(false);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Failed to import thread");
			} finally {
				setImportingId(null);
			}
		},
		[agentId, importingId, target, onImported, onOpenChange]
	);

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
											className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted disabled:opacity-50"
											disabled={importingId !== null}
											onClick={() => handleImport(thread)}
											type="button"
										>
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
												{importingId === thread.id && (
													<Spinner className="size-3" />
												)}
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
			</DialogContent>
		</Dialog>
	);
}
