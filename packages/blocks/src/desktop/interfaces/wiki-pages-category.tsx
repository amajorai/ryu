import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import { useMemo, useState } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	categoryLetters,
	DEFAULT_THREAD_SORT,
	indexEntries,
	nextSort,
	sortThreads,
	WIKI_INDEX_LABELS,
	type WikiIndex,
	type WikiSortState,
	type WikiThreadSort,
	wikiAgent,
	wikiAgo,
	wikiStamp,
	wikiThreadTitle,
} from "./wiki-model.ts";
import { LIST } from "./wiki-pages-marks.tsx";
import { PROSE, WikiFooter, WikiLink } from "./wiki-parts.tsx";

// ---------------------------------------------------------------------------
// Category pages and the List of threads
// ---------------------------------------------------------------------------

export function CategoryPage({
	index,
	snapshot,
}: {
	index: Exclude<WikiIndex, "threads">;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const entries = indexEntries(snapshot, index);
	const letters = categoryLetters(entries);
	const label = WIKI_INDEX_LABELS[index];
	return (
		<div className="pt-4">
			<p className={PROSE}>
				{tl(
					"This category lists every {index, select, agents {agent} teams {team} other {project}} in the workspace. Select a page to read its article.",
					{ index }
				)}
			</p>
			<h2 className="mt-6 mb-2 border-border border-b pb-1 font-normal font-serif text-[22px] leading-8">
				{tl("Pages in category “{label}”", { label })}
			</h2>
			{entries.length > 0 ? (
				<>
					<p className={`${PROSE} mb-3`}>
						{tl(
							"{count, plural, one {The following {countText} page is in this category, out of {total} total.} other {The following {countText} pages are in this category, out of {total} total.}}",
							{
								count: entries.length,
								countText: entries.length.toLocaleString("en"),
								total: entries.length.toLocaleString("en"),
							}
						)}
					</p>
					<div className="@2xl/article:columns-2 @4xl/article:columns-3 gap-8">
						{letters.map((group) => (
							<div className="break-inside-avoid pb-3" key={group.letter}>
								<h3 className="font-semibold text-sm leading-6">
									{group.letter}
								</h3>
								<ul className={LIST}>
									{group.entries.map((entry) => (
										<li key={entry.id}>
											<WikiLink route={entry.route}>{entry.title}</WikiLink>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</>
			) : (
				<p className="text-muted-foreground text-sm italic leading-6">
					This category currently contains no pages.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

const COLUMNS: { key: WikiThreadSort; label: string; numeric?: boolean }[] = [
	{ key: "title", label: "Thread" },
	{ key: "status", label: "Status" },
	{ key: "agents", label: "Agents" },
	{ key: "messages", label: "Messages", numeric: true },
	{ key: "updated", label: "Last updated" },
];

export function ThreadListPage({
	now,
	snapshot,
}: {
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const [sort, setSort] = useState<WikiSortState>(DEFAULT_THREAD_SORT);
	const rows = useMemo(
		() => sortThreads(snapshot, snapshot.threads, sort),
		[snapshot, sort]
	);
	const working = snapshot.threads.filter((thread) => thread.running).length;
	const threadValues = {
		count: snapshot.threads.length,
		countText: snapshot.threads.length.toLocaleString("en"),
	};
	return (
		<div className="pt-4">
			<p className={PROSE}>
				{working > 0
					? tl(
							"This is a list of all {count, plural, one {{countText} thread} other {{countText} threads}} in the workspace, {workingText} of them with a live run. Select a column heading to sort the table.",
							{
								...threadValues,
								workingText: working.toLocaleString("en"),
							}
						)
					: tl(
							"This is a list of all {count, plural, one {{countText} thread} other {{countText} threads}} in the workspace. Select a column heading to sort the table.",
							threadValues
						)}
			</p>
			{rows.length > 0 ? (
				<div className="mt-4 overflow-x-auto">
					<table className="w-full min-w-[640px] border-collapse border border-border text-sm leading-5">
						<thead>
							<tr className="bg-muted">
								{COLUMNS.map((column) => {
									const active = sort.key === column.key;
									let icon = <ChevronsUpDown className="size-3" />;
									if (active) {
										icon =
											sort.direction === "ascending" ? (
												<ChevronUp className="size-3" />
											) : (
												<ChevronDown className="size-3" />
											);
									}
									return (
										<th
											aria-sort={active ? sort.direction : "none"}
											className={cn(
												"border border-border p-0 font-semibold",
												column.numeric ? "text-right" : "text-left"
											)}
											key={column.key}
											scope="col"
										>
											<button
												className={cn(
													"flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
													column.numeric && "justify-end"
												)}
												onClick={() =>
													setSort((current) => nextSort(current, column.key))
												}
												type="button"
											>
												{column.label}
												<span
													aria-hidden="true"
													className={
														active ? "text-foreground" : "text-muted-foreground"
													}
												>
													{icon}
												</span>
											</button>
										</th>
									);
								})}
							</tr>
						</thead>
						<tbody>
							{rows.map((thread) => (
								<ThreadRow
									key={thread.id}
									now={now}
									snapshot={snapshot}
									thread={thread}
								/>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="mt-4 text-muted-foreground text-sm italic leading-6">
					There are no threads yet.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

function ThreadRow({
	now,
	snapshot,
	thread,
}: {
	now: number;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const agents = thread.agentIds
		.map((id) => wikiAgent(snapshot, id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	const cell = "border border-border px-2 py-1.5 align-top";
	return (
		<tr className="even:bg-muted/30">
			<td className={cell}>
				<WikiLink route={{ id: thread.id, kind: "thread" }}>
					{wikiThreadTitle(thread)}
				</WikiLink>
			</td>
			<td className={cn(cell, "whitespace-nowrap")}>
				<span className="inline-flex items-center gap-1.5">
					<BoardStatusDot status={status} />
					{THREAD_STATUS_LABELS[status]}
				</span>
			</td>
			<td className={cell}>
				{agents.length > 0 ? (
					agents.map((agent, index) => (
						<span key={agent.id}>
							{index > 0 ? ", " : null}
							<WikiLink route={{ id: agent.id, kind: "agent" }}>
								{agent.name}
							</WikiLink>
						</span>
					))
				) : (
					<span className="text-muted-foreground">&ndash;</span>
				)}
			</td>
			<td className={cn(cell, "text-right tabular-nums")}>
				{thread.messageCount}
			</td>
			<td className={cn(cell, "whitespace-nowrap")}>
				<time dateTime={thread.updatedAt} title={wikiStamp(thread.updatedAt)}>
					{wikiAgo(thread.updatedAt, now)}
				</time>
			</td>
		</tr>
	);
}
