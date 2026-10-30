import { useLiteralMessages } from "@ryu/i18n/react";
import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	countWord,
	eventOutcome,
	type WikiRoute,
	wikiAgo,
	wikiThreadTitle,
} from "./wiki-model.ts";
import { PROSE, WikiLink } from "./wiki-parts.tsx";

export const LIST =
	"list-disc space-y-1 pl-6 text-sm leading-6 marker:text-muted-foreground";
export const NOTE = "text-muted-foreground text-sm leading-6";

export function Status({ thread }: { thread: InterfaceThread }) {
	const status = threadStatus(thread);
	return (
		<span className="inline-flex items-center gap-1.5">
			<BoardStatusDot status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

export function Comma({ items }: { items: ReactNode[] }) {
	return (
		<>
			{items.map((item, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: separators follow a fixed list.
				<span key={index}>
					{index > 0 ? ", " : null}
					{item}
				</span>
			))}
		</>
	);
}

export function agentRoute(agent: InterfaceAgent): WikiRoute {
	return { id: agent.id, kind: "agent" };
}

export function threadRoute(thread: InterfaceThread): WikiRoute {
	return { id: thread.id, kind: "thread" };
}

/** One thread as a list line: link, then plain facts in the reference's voice. */
export function ThreadLine({
	now,
	thread,
	withAgents,
	snapshot,
}: {
	now: number;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
	withAgents?: boolean;
}) {
	const tl = useLiteralMessages();
	const names = withAgents
		? thread.agentIds
				.map((id) => snapshot.agents.find((agent) => agent.id === id))
				.filter((agent) => agent !== undefined)
		: [];
	const status = threadStatus(thread);
	return (
		<li>
			<WikiLink route={threadRoute(thread)}>{wikiThreadTitle(thread)}</WikiLink>
			{names.length > 0 ? (
				<>
					{" "}
					with{" "}
					<Comma
						items={names.map((agent) => (
							<WikiLink key={agent.id} route={agentRoute(agent)}>
								{agent.name}
							</WikiLink>
						))}
					/>
				</>
			) : null}
			<span className="text-muted-foreground">
				{" "}
				{tl(
					"({count, plural, one {{countText} message} other {{countText} messages}}, updated {ago}{status})",
					{
						ago: wikiAgo(thread.updatedAt, now),
						count: thread.messageCount,
						countText: countWord(thread.messageCount),
						status:
							status === "quiet"
								? ""
								: `; ${THREAD_STATUS_LABELS[status].toLowerCase()}`,
					}
				)}
			</span>
		</li>
	);
}

function runLine(event: InterfaceEvent): string {
	const parts = [event.title];
	if (event.label) {
		parts.push(event.label.toLowerCase());
	}
	return parts.join(", ");
}

export function RunList({
	events,
	now,
}: {
	events: InterfaceEvent[];
	now: number;
}) {
	const tl = useLiteralMessages();
	return (
		<ul className={LIST}>
			{events.map((event) => (
				<li key={event.id}>
					{runLine(event)}
					<span className="text-muted-foreground">
						{" "}
						&ndash;{" "}
						{event.kind === "upcoming"
							? tl("next run {ago}", { ago: wikiAgo(event.start, now) })
							: `${eventOutcome(event)} ${wikiAgo(event.start, now)}`}
						{event.count && event.count > 1 ? (
							<> {tl("({count} runs)", { count: String(event.count) })}</>
						) : (
							""
						)}
					</span>
				</li>
			))}
		</ul>
	);
}

export function Missing({ noun }: { noun: string }) {
	const tl = useLiteralMessages();
	return (
		<div className="pt-4">
			<p className={PROSE}>
				{tl(
					"The wiki does not have a {noun} with this name. It may have been deleted or renamed.",
					{ noun }
				)}
			</p>
			<p className={`${PROSE} mt-3`}>
				Return to the <WikiLink route={{ kind: "main" }}>Main Page</WikiLink> or
				browse the{" "}
				<WikiLink route={{ index: "threads", kind: "index" }}>
					List of threads
				</WikiLink>
				.
			</p>
		</div>
	);
}
