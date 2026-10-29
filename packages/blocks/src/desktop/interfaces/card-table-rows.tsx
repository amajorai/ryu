import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
	waitLabel,
} from "@ryuhq/protocol/interfaces";
import { createContext, useContext } from "react";
import type { CardVerdict } from "./card-table-model.ts";
import { SuitGlyph } from "./card-table-pieces.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";

/**
 * The act layer's word on each thread's card (`actCardVerdicts`) and the
 * act clock. Absent without acts: every card and row reads its thread as
 * before.
 */
export interface CardVerdicts {
	nowMs: number;
	verdicts: ReadonlyMap<string, CardVerdict>;
}

export const CardVerdictsContext = createContext<CardVerdicts | null>(null);

/** How a thread reads: its act verdict, or its own status without acts. */
export interface ThreadReading {
	/** "14m" ("~14m" estimated), from the ask or the failure with acts; null for none. */
	age: string | null;
	/** With acts, an ask's head ("Run deploy.sh?"): the card's message line. */
	head: string | null;
	/** The status words for its accessible name and its row. */
	label: string;
	status: ThreadStatus;
	/** The footer's words with acts (null lets the suit speak). */
	verdictLabel: string | null;
	/** True when the acts drive this reading. */
	viaActs: boolean;
}

/**
 * A status's words with acts. The acts quiet a thread nothing waits on (a
 * finished reply, an old stop): one with messages is "Done"; only a thread
 * with none is "Not started".
 */
export function actStatusLabel(
	status: ThreadStatus,
	thread: InterfaceThread
): string {
	if (status === "quiet") {
		return thread.messageCount > 0 ? "Done" : THREAD_STATUS_LABELS.quiet;
	}
	return THREAD_STATUS_LABELS[status];
}

export function useThreadReading(
	thread: InterfaceThread,
	now: number
): ThreadReading {
	return threadReading(thread, now, useContext(CardVerdictsContext));
}

/** `useThreadReading` for lists that read the context once. */
export function threadReading(
	thread: InterfaceThread,
	now: number,
	acts: CardVerdicts | null
): ThreadReading {
	const verdict = acts?.verdicts.get(thread.id);
	if (!(acts && verdict)) {
		const status = threadStatus(thread);
		return {
			age: compactAge(thread.updatedAt, now),
			head: null,
			label: THREAD_STATUS_LABELS[status],
			status,
			verdictLabel: null,
			viaActs: false,
		};
	}
	return {
		age:
			waitLabel(verdict.since, acts.nowMs, { approx: verdict.approx }) || null,
		head: verdict.head,
		label: verdict.label ?? actStatusLabel(verdict.status, thread),
		status: verdict.status,
		verdictLabel: verdict.label,
		viaActs: true,
	};
}

/**
 * One thread as a compact, clickable row: suit, title, and where it stands.
 * Used by seat menus, the pot, and the rail, so every list on the table reads
 * the same way.
 */
export function ThreadRow({
	active,
	now,
	onOpen,
	showAgent = false,
	snapshot,
	thread,
}: {
	active: boolean;
	now: number;
	onOpen: (threadId: string) => void;
	showAgent?: boolean;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const reading = useThreadReading(thread, now);
	const { age, status } = reading;
	const title = thread.title.trim() || "Untitled thread";
	const agent = agentById(snapshot, thread.agentIds[0]);
	const meta = [
		reading.label,
		showAgent ? (agent?.name ?? "No agent") : null,
		age,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<li>
			<button
				aria-current={active ? "true" : undefined}
				className={cn(
					"group/row flex w-full min-w-0 items-start gap-2.5 rounded-xl px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
					active && "bg-muted"
				)}
				data-thread-id={thread.id}
				onClick={() => onOpen(thread.id)}
				type="button"
			>
				<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-card text-xs shadow-xs">
					<SuitGlyph status={status} />
				</span>
				<span className="flex min-w-0 flex-1 flex-col">
					<span className="truncate font-medium text-foreground text-sm leading-5">
						{title}
					</span>
					<span
						className={cn(
							"truncate text-muted-foreground text-xs",
							status === "attention" && "text-status-destructive"
						)}
					>
						{meta}
					</span>
				</span>
			</button>
		</li>
	);
}
