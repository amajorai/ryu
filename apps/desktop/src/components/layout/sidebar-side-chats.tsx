// Nested side-chat list rendered under an expanded sidebar chat row.

import { MessageQuestionIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { SidebarMenu, SidebarMenuItem } from "@ryu/ui/components/sidebar.tsx";
import { useEffect, useRef, useState } from "react";
import type { BtwEntry } from "@/src/lib/api/btw.ts";
import { listBtw } from "@/src/lib/api/btw.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { compactAge } from "@/src/lib/time.ts";
import { OverflowTooltip } from "./overflow-tooltip.tsx";

/** Lazily-loaded list of a conversation's persisted `/btw` side chats, shown
 *  indented under its row. Only mounted when the row is expanded, so collapsed
 *  rows never hit Core. Reads the node target through a ref so the fresh
 *  `toTarget()` object identity each render doesn't retrigger the fetch (see the
 *  desktop target-object deps gotcha). */
export function SidebarSideChats({
	conversationId,
	target,
	onOpen,
}: {
	conversationId: string;
	onOpen: (entry: BtwEntry) => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [entries, setEntries] = useState<BtwEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const targetRef = useRef(target);
	targetRef.current = target;

	useEffect(() => {
		const controller = new AbortController();
		listBtw(targetRef.current, conversationId, controller.signal)
			.then((list) => {
				if (!controller.signal.aborted) {
					setEntries(list);
				}
			})
			.catch(() => {
				/* treated as no side chats */
			})
			.finally(() => {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			});
		return () => controller.abort();
	}, [conversationId]);

	if (loading) {
		return <p className="py-1 pl-8 text-muted-foreground text-xs">Loading…</p>;
	}
	if (entries.length === 0) {
		return (
			<p className="py-1 pl-8 text-muted-foreground text-xs">No side chats</p>
		);
	}
	return (
		<div className="relative ml-2 border-border border-l pl-2">
			<SidebarMenu>
				{entries.map((entry) => {
					const answerPreview = entry.answer.split(/\r?\n/)[0]?.trim() ?? "";
					const kindLabel =
						entry.kind === "subagent" ? "Subagent" : "Side chat";
					return (
						<SidebarMenuItem key={entry.id}>
							<button
								aria-label={
									entry.kind === "subagent"
										? tl("Open subagent: {question}", {
												question: entry.question,
											})
										: tl("Open side chat: {question}", {
												question: entry.question,
											})
								}
								className="group relative flex min-h-10 w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors duration-150 hover:bg-sidebar-accent/60 hover:duration-0"
								onClick={() => onOpen(entry)}
								type="button"
							>
								<span
									aria-hidden="true"
									className="absolute top-3 -left-[5px] size-2 rounded-full bg-primary ring-2 ring-sidebar"
								/>
								<HugeiconsIcon
									className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
									icon={MessageQuestionIcon}
								/>
								<span className="min-w-0 flex-1">
									<span className="flex min-w-0 items-center gap-1.5">
										<OverflowTooltip
											className="min-w-0 flex-1 overflow-hidden whitespace-nowrap font-medium text-foreground/85 text-xs"
											fade
											text={entry.question}
										/>
										<span className="shrink-0 text-muted-foreground/70 text-xs">
											{compactAge(entry.created_at)}
										</span>
									</span>
									<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-muted-foreground/70 text-xs">
										<span className="shrink-0">{kindLabel}</span>
										{answerPreview && (
											<OverflowTooltip
												className="min-w-0 flex-1 overflow-hidden whitespace-nowrap"
												fade
												text={answerPreview}
											/>
										)}
									</span>
								</span>
							</button>
						</SidebarMenuItem>
					);
				})}
			</SidebarMenu>
		</div>
	);
}
