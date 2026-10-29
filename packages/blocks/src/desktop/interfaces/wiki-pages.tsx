import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	useId,
	useMemo,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	agentLeadIntro,
	agentRevisions,
	byRecency,
	categoryLetters,
	changesByDay,
	DEFAULT_THREAD_SORT,
	didYouKnow,
	eventOutcome,
	eventsOnDay,
	excerptAround,
	featuredAgent,
	indexEntries,
	newsItem,
	nextSort,
	plural,
	sortThreads,
	threadRevisions,
	WIKI_INDEX_LABELS,
	type WikiIndex,
	type WikiRevision,
	type WikiRoute,
	type WikiSortState,
	type WikiThreadSort,
	wikiAgent,
	wikiAgentArticle,
	wikiAgo,
	wikiGroupArticle,
	wikiMonthDay,
	wikiSearch,
	wikiStamp,
	wikiThreadArticle,
	wikiThreadTitle,
	wikiTime,
} from "./wiki-model.ts";
import {
	LINK,
	Marked,
	PROSE,
	WikiFooter,
	WikiLink,
	WikiPortrait,
	WikiText,
} from "./wiki-parts.tsx";

const LIST =
	"list-disc space-y-1 pl-6 text-sm leading-6 marker:text-muted-foreground";

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function Panel({
	children,
	footer,
	title,
	tone,
}: {
	children: ReactNode;
	footer?: ReactNode;
	title: string;
	tone: "lead" | "side";
}) {
	return (
		<section aria-label={title} className="border border-border">
			<h2
				className={cn(
					"border-border border-b px-3 py-1 font-semibold font-serif text-[17px] leading-7",
					tone === "lead" ? "bg-primary/10" : "bg-muted/70"
				)}
			>
				{title}
			</h2>
			<div className="px-3 pt-2 pb-3">
				{children}
				{footer ? (
					<p className="mt-2 text-right text-[13px] leading-5">{footer}</p>
				) : null}
			</div>
		</section>
	);
}

export function MainPage({
	now,
	onStart,
	snapshot,
}: {
	now: number;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	snapshot: InterfaceSnapshot;
}) {
	const featured = featuredAgent(snapshot);
	const news = useMemo(
		() => [...snapshot.threads].sort(byRecency).slice(0, 5),
		[snapshot.threads]
	);
	const ongoing = snapshot.threads
		.filter((thread) => thread.running)
		.sort(byRecency);
	const facts = didYouKnow(snapshot);
	const today = eventsOnDay(snapshot, now);
	const teams = snapshot.groups.filter((group) => group.kind === "team").length;
	const projects = snapshot.groups.length - teams;
	const empty = snapshot.agents.length === 0 && snapshot.threads.length === 0;
	const recentlyFeatured = featured
		? snapshot.agents
				.filter((agent) => agent.id !== featured.agent.id)
				.map((agent) => wikiAgentArticle(snapshot, agent.id))
				.filter((article) => article !== null && article.threads.length > 0)
				.sort((a, b) => (b?.threads.length ?? 0) - (a?.threads.length ?? 0))
				.slice(0, 3)
		: [];

	return (
		<div className="pt-4">
			<section className="border border-border bg-muted/40 px-4 py-5 text-center">
				<h1 className="font-normal font-serif text-[28px] leading-9">
					Welcome to the wiki,
				</h1>
				<p className="mt-1 text-sm leading-6">
					the encyclopedia of this workspace&rsquo;s agents, teams, projects and
					threads.
				</p>
				<p className="mt-2 text-[13px] text-muted-foreground leading-5">
					<WikiLink route={{ index: "agents", kind: "index" }}>
						{tally(snapshot.agents.length, "agent")}
					</WikiLink>
					<Dot />
					<WikiLink route={{ index: "teams", kind: "index" }}>
						{tally(teams, "team")}
					</WikiLink>
					<Dot />
					<WikiLink route={{ index: "projects", kind: "index" }}>
						{tally(projects, "project")}
					</WikiLink>
					<Dot />
					<WikiLink route={{ index: "threads", kind: "index" }}>
						{tally(snapshot.threads.length, "thread")}
					</WikiLink>
				</p>
			</section>

			{empty ? (
				<div className="mt-6 max-w-2xl">
					<h2 className="border-border border-b pb-1 font-normal font-serif text-[22px] leading-8">
						This wiki has no pages yet
					</h2>
					<p className={`${PROSE} mt-2`}>
						Pages are written from your workspace: every agent, team, project
						and thread gets an article. Start the first thread here and it will
						appear on this page.
					</p>
					<TopicForm
						agents={snapshot.agents}
						className="mt-4"
						label="First message"
						onSubmit={onStart}
						placeholder="What should an agent work on?"
						submitLabel="Start thread"
					/>
				</div>
			) : (
				<div className="mt-4 grid @3xl/article:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] gap-4">
					<div className="flex min-w-0 flex-col gap-4">
						<Panel
							footer={
								<WikiLink route={{ index: "agents", kind: "index" }}>
									More agents
								</WikiLink>
							}
							title="From today’s featured article"
							tone="lead"
						>
							{featured ? (
								<>
									<WikiPortrait
										agent={featured.agent}
										className="float-left mt-1 mr-3 mb-1 border border-border"
										size={96}
									/>
									<p className={PROSE}>
										<WikiText segments={agentLeadIntro(featured)} />{" "}
										{featured.threads[0] ? (
											<>
												Its most recent thread is{" "}
												<WikiLink
													route={{ id: featured.threads[0].id, kind: "thread" }}
												>
													{wikiThreadTitle(featured.threads[0])}
												</WikiLink>
												, updated {wikiAgo(featured.threads[0].updatedAt, now)}.
											</>
										) : null}{" "}
										(
										<WikiLink
											bold
											route={{ id: featured.agent.id, kind: "agent" }}
										>
											Full article&hellip;
										</WikiLink>
										)
									</p>
									{recentlyFeatured.length > 0 ? (
										<p className="clear-both pt-2 text-[13px] leading-5">
											Recently featured:{" "}
											{recentlyFeatured.map((article, index) =>
												article ? (
													<span key={article.agent.id}>
														{index > 0 ? <Dot /> : null}
														<WikiLink
															route={{ id: article.agent.id, kind: "agent" }}
														>
															{article.agent.name}
														</WikiLink>
													</span>
												) : null
											)}
										</p>
									) : null}
								</>
							) : (
								<p className={PROSE}>No agents yet.</p>
							)}
						</Panel>
						{facts.length > 0 ? (
							<Panel title="Did you know ..." tone="lead">
								<ul className={LIST}>
									{facts.map((fact) => (
										<li key={fact.map((segment) => segment.text).join("")}>
											<WikiText segments={fact} />
										</li>
									))}
								</ul>
							</Panel>
						) : null}
					</div>
					<div className="flex min-w-0 flex-col gap-4">
						<Panel
							footer={
								<WikiLink route={{ kind: "changes" }}>Recent changes</WikiLink>
							}
							title="In the news"
							tone="side"
						>
							{news.length > 0 ? (
								<ul className={LIST}>
									{news.map((thread) => (
										<li key={thread.id}>
											<WikiText segments={newsItem(snapshot, thread)} />
										</li>
									))}
								</ul>
							) : (
								<p className={PROSE}>No threads yet.</p>
							)}
							{ongoing.length > 0 ? (
								<p className="mt-2 border-border border-t pt-2 text-[13px] leading-5">
									<b className="font-semibold">Ongoing:</b>{" "}
									{ongoing.map((thread, index) => (
										<span key={thread.id}>
											{index > 0 ? <Dot /> : null}
											<WikiLink route={{ id: thread.id, kind: "thread" }}>
												{wikiThreadTitle(thread)}
											</WikiLink>
										</span>
									))}
								</p>
							) : null}
						</Panel>
						{today.length > 0 ? (
							<Panel title="On this day" tone="side">
								<p className="mb-2 font-semibold text-sm leading-6">
									{wikiMonthDay(now)}
								</p>
								<ul className={LIST}>
									{today.map(({ agent, event }) => (
										<li key={event.id}>
											<b className="font-semibold tabular-nums">
												{wikiTime(event.start)}
											</b>{" "}
											&ndash; {event.title}
											{agent ? (
												<>
													{" "}
													for{" "}
													<WikiLink route={{ id: agent.id, kind: "agent" }}>
														{agent.name}
													</WikiLink>
												</>
											) : null}
											<span className="text-muted-foreground">
												{" "}
												({eventOutcome(event)})
											</span>
										</li>
									))}
								</ul>
							</Panel>
						) : null}
					</div>
				</div>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

/** Digits for stat lines ("6 agents"), where prose would spell them out. */
function tally(count: number, noun: string): string {
	return `${count.toLocaleString("en")} ${count === 1 ? noun : `${noun}s`}`;
}

function Dot() {
	return (
		<span aria-hidden="true" className="px-1.5 text-muted-foreground">
			&middot;
		</span>
	);
}

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
	const entries = indexEntries(snapshot, index);
	const letters = categoryLetters(entries);
	const label = WIKI_INDEX_LABELS[index];
	const noun =
		index === "agents" ? "agent" : index === "teams" ? "team" : "project";
	return (
		<div className="pt-4">
			<p className={PROSE}>
				This category lists every {noun} in the workspace. Select a page to read
				its article.
			</p>
			<h2 className="mt-6 mb-2 border-border border-b pb-1 font-normal font-serif text-[22px] leading-8">
				Pages in category &ldquo;{label}&rdquo;
			</h2>
			{entries.length > 0 ? (
				<>
					<p className={`${PROSE} mb-3`}>
						The following {plural(entries.length, "page")}{" "}
						{entries.length === 1 ? "is" : "are"} in this category, out of{" "}
						{entries.length.toLocaleString("en")} total.
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
	const [sort, setSort] = useState<WikiSortState>(DEFAULT_THREAD_SORT);
	const rows = useMemo(
		() => sortThreads(snapshot, snapshot.threads, sort),
		[snapshot, sort]
	);
	const working = snapshot.threads.filter((thread) => thread.running).length;
	return (
		<div className="pt-4">
			<p className={PROSE}>
				This is a list of all {plural(snapshot.threads.length, "thread")} in the
				workspace
				{working > 0
					? `, ${plural(working, "of them", "of them")} with a live run`
					: ""}
				. Select a column heading to sort the table.
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

// ---------------------------------------------------------------------------
// Revisions: View history and Recent changes
// ---------------------------------------------------------------------------

function RevisionRow({
	revision,
	showTitle,
	snapshot,
	timeOnly,
}: {
	revision: WikiRevision;
	showTitle: boolean;
	snapshot: InterfaceSnapshot;
	timeOnly?: boolean;
}) {
	const stamp = timeOnly ? wikiTime(revision.at) : wikiStamp(revision.at);
	const row =
		"flex min-w-0 flex-wrap items-baseline gap-x-2 py-1 text-sm leading-6 @2xl/article:flex-nowrap @2xl/article:whitespace-nowrap";
	const time = (
		<time
			className="shrink-0 text-muted-foreground tabular-nums"
			dateTime={revision.at}
		>
			{stamp}
		</time>
	);
	if (revision.kind === "run") {
		const { event } = revision;
		const agent = wikiAgent(snapshot, event.agentId);
		return (
			<li className={row}>
				{time}
				<span className="shrink-0">{event.title}</span>
				<Sep />
				<span
					className={cn(
						"shrink-0",
						event.outcome === "failure"
							? "text-destructive"
							: "text-muted-foreground"
					)}
				>
					(scheduled run, {eventOutcome(event)})
				</span>
				{agent ? (
					<>
						<Sep />
						<WikiLink
							className="shrink-0"
							route={{ id: agent.id, kind: "agent" }}
						>
							{agent.name}
						</WikiLink>
					</>
				) : null}
			</li>
		);
	}
	const { thread } = revision;
	const agents = thread.agentIds
		.map((id) => wikiAgent(snapshot, id))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
	return (
		<li className={row}>
			{showTitle ? (
				<>
					{time}
					<WikiLink
						className="shrink-0"
						route={{ id: thread.id, kind: "thread" }}
					>
						{wikiThreadTitle(thread)}
					</WikiLink>
				</>
			) : (
				<WikiLink
					className="shrink-0 tabular-nums"
					keepLinkStyle
					route={{ id: thread.id, kind: "thread" }}
				>
					{stamp}
				</WikiLink>
			)}
			<Sep />
			<span className="shrink-0 text-muted-foreground">
				({plural(thread.messageCount, "message")})
			</span>
			<Sep />
			<span className="shrink-0">
				{agents.length > 0
					? agents.map((agent, index) => (
							<span key={agent.id}>
								{index > 0 ? ", " : null}
								<WikiLink route={{ id: agent.id, kind: "agent" }}>
									{agent.name}
								</WikiLink>
							</span>
						))
					: "You"}
			</span>
			{thread.lastMessage ? (
				<i className="min-w-0 max-w-full flex-1 truncate text-muted-foreground">
					({thread.lastMessage})
				</i>
			) : null}
		</li>
	);
}

function Sep() {
	return (
		<span aria-hidden="true" className="text-muted-foreground">
			. .
		</span>
	);
}

export function HistoryPage({
	route,
	snapshot,
}: {
	route: WikiRoute;
	snapshot: InterfaceSnapshot;
}) {
	let revisions: WikiRevision[] = [];
	let note =
		"Each row is a thread or a scheduled run, newest first. Select a title to read its article.";
	if (route.kind === "agent") {
		const article = wikiAgentArticle(snapshot, route.id);
		revisions = article ? agentRevisions(article) : [];
	} else if (route.kind === "group") {
		const article = wikiGroupArticle(snapshot, route.id);
		revisions = article ? threadRevisions(article.threads) : [];
	} else if (route.kind === "thread") {
		const article = wikiThreadArticle(snapshot, route.id);
		revisions = article ? threadRevisions([article.thread]) : [];
		note =
			"Only the latest revision is kept here; select its timestamp to read it. The talk page holds the full conversation.";
	} else {
		revisions = threadRevisions(snapshot.threads);
	}
	return (
		<div className="pt-4">
			<p className="text-muted-foreground text-sm leading-6">{note}</p>
			{revisions.length > 0 ? (
				<ul className="mt-3 border-border border-t pt-2">
					{revisions.map((revision) => (
						<RevisionRow
							key={
								revision.kind === "run" ? revision.event.id : revision.thread.id
							}
							revision={revision}
							showTitle={route.kind !== "thread"}
							snapshot={snapshot}
						/>
					))}
				</ul>
			) : (
				<p className="mt-3 text-muted-foreground text-sm italic leading-6">
					No revision history for this page yet.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

export function RecentChangesPage({
	snapshot,
}: {
	snapshot: InterfaceSnapshot;
}) {
	const days = changesByDay(threadRevisions(snapshot.threads));
	return (
		<div className="pt-4">
			<p className={PROSE}>
				Track the most recent activity on the wiki: every thread, newest first,
				with its size and who took part.
			</p>
			{days.length > 0 ? (
				days.map((day) => (
					<section aria-label={day.day} className="mt-5" key={day.key}>
						<h2 className="border-border border-b pb-1 font-semibold text-sm leading-6">
							{day.day}
						</h2>
						<ul className="pt-1">
							{day.revisions.map((revision) => (
								<RevisionRow
									key={
										revision.kind === "run"
											? revision.event.id
											: revision.thread.id
									}
									revision={revision}
									showTitle
									snapshot={snapshot}
									timeOnly
								/>
							))}
						</ul>
					</section>
				))
			) : (
				<p className="mt-4 text-muted-foreground text-sm italic leading-6">
					No changes yet.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

export function SearchPage({
	onSearch,
	query,
	snapshot,
}: {
	onSearch: (query: string) => void;
	query: string;
	snapshot: InterfaceSnapshot;
}) {
	const hits = useMemo(() => wikiSearch(snapshot, query), [snapshot, query]);
	const [draft, setDraft] = useState(query);
	const fieldId = useId();
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (draft.trim()) {
			onSearch(draft.trim());
		}
	};
	return (
		<div className="pt-4">
			<form className="flex max-w-xl" onSubmit={submit} role="search">
				<label className="sr-only" htmlFor={fieldId}>
					Search query
				</label>
				<input
					className="h-9 min-w-0 flex-1 rounded-l-[2px] border border-input bg-background px-3 text-sm outline-none hover:border-ring/60 focus:border-ring focus:ring-1 focus:ring-ring [&::-webkit-search-cancel-button]:appearance-none"
					id={fieldId}
					onChange={(event) => setDraft(event.target.value)}
					type="search"
					value={draft}
				/>
				<button
					className="-ml-px h-9 cursor-pointer rounded-r-[2px] bg-primary px-4 font-medium text-primary-foreground text-sm outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:bg-primary/80"
					type="submit"
				>
					Search
				</button>
			</form>
			<p className="mt-4 border-border border-b pb-2 text-[13px] text-muted-foreground leading-5">
				{hits.length > 0
					? `Showing ${hits.length === 1 ? "the only result" : `${hits.length} results`} for “${query}”.`
					: `There were no results matching the query “${query}”.`}
			</p>
			{hits.length > 0 ? (
				<ul className="mt-2">
					{hits.map((hit) => {
						const snippet = excerptAround(hit.snippet, query);
						return (
							<li className="py-2" key={`${hit.entry.kind}-${hit.entry.id}`}>
								<WikiLink
									className="text-base leading-6"
									route={hit.entry.route}
								>
									<Marked query={query} value={hit.entry.title} />
								</WikiLink>
								{snippet && snippet !== hit.entry.description ? (
									<p className="text-sm leading-6">
										<Marked query={query} value={snippet} />
									</p>
								) : null}
								<p className="text-[13px] text-muted-foreground leading-5">
									{hit.entry.description}
									{hit.entry.updatedAt
										? ` · ${wikiStamp(hit.entry.updatedAt)}`
										: ""}
								</p>
							</li>
						);
					})}
				</ul>
			) : (
				<p className={`${PROSE} mt-3`}>
					Try fewer words, or browse the{" "}
					<WikiLink route={{ index: "threads", kind: "index" }}>
						List of threads
					</WikiLink>
					.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

// ---------------------------------------------------------------------------
// Talk pages (agents, groups, main page): topics plus "Add topic"
// ---------------------------------------------------------------------------

export function TopicForm({
	agents,
	className,
	label,
	onSubmit,
	placeholder,
	submitLabel = "Add topic",
}: {
	/** Offer a recipient picker when more than one agent could answer. */
	agents?: InterfaceAgent[];
	className?: string;
	label: string;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
	placeholder: string;
	submitLabel?: string;
}) {
	const fieldId = useId();
	const pickerId = useId();
	const [prompt, setPrompt] = useState("");
	const [agentId, setAgentId] = useState("");
	const trimmed = prompt.trim();
	const pick = agents && agents.length > 1;
	const recipient = agents?.some((agent) => agent.id === agentId)
		? agentId
		: undefined;
	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit({ agentId: recipient, prompt: trimmed });
		setPrompt("");
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form
			className={cn("flex flex-col gap-2", className)}
			onSubmit={onFormSubmit}
		>
			<label className="font-semibold text-sm leading-6" htmlFor={fieldId}>
				{label}
			</label>
			<textarea
				className="min-h-24 w-full resize-y rounded-[2px] border border-input bg-background px-3 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground hover:border-ring/60 focus:border-ring focus:ring-1 focus:ring-ring"
				id={fieldId}
				maxLength={8000}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={placeholder}
				value={prompt}
			/>
			<div className="flex flex-wrap items-center justify-between gap-2">
				{pick ? (
					<span className="flex items-center gap-2 text-sm">
						<label className="text-muted-foreground" htmlFor={pickerId}>
							Ask
						</label>
						<select
							className="h-8 rounded-[2px] border border-input bg-background px-2 text-sm outline-none focus:border-ring focus:ring-1 focus:ring-ring"
							id={pickerId}
							onChange={(event) => setAgentId(event.target.value)}
							value={recipient ?? ""}
						>
							<option value="">Any agent</option>
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name}
								</option>
							))}
						</select>
					</span>
				) : (
					<span className="text-muted-foreground text-xs leading-5">
						Enter to send, Shift+Enter for a new line
					</span>
				)}
				<button
					className="h-8 cursor-pointer rounded-[2px] bg-primary px-4 font-medium text-primary-foreground text-sm outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 active:bg-primary/80 disabled:cursor-default disabled:opacity-50"
					disabled={!trimmed}
					type="submit"
				>
					{submitLabel}
				</button>
			</div>
		</form>
	);
}

export function TalkPage({
	agents,
	intro,
	now,
	onOpenThread,
	onStart,
	pageTitle,
	snapshot,
	threads,
}: {
	agents?: InterfaceAgent[];
	intro: ReactNode;
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	pageTitle: string;
	snapshot: InterfaceSnapshot;
	threads: InterfaceThread[];
}) {
	return (
		<div className="pt-4">
			<div className="border border-border bg-muted/40 px-3 py-2 text-sm leading-6">
				{intro}
			</div>
			<TopicForm
				agents={agents}
				className="mt-4"
				label="Add a topic"
				onSubmit={onStart}
				placeholder={`Start a new thread about ${pageTitle}`}
			/>
			{threads.length > 0 ? (
				<ul className="mt-2">
					{threads.map((thread) => (
						<TopicItem
							key={thread.id}
							now={now}
							onOpen={() => onOpenThread(thread.id)}
							snapshot={snapshot}
							thread={thread}
						/>
					))}
				</ul>
			) : (
				<p className="mt-6 text-muted-foreground text-sm italic leading-6">
					There are no topics on this page yet.
				</p>
			)}
			<WikiFooter edited={null} />
		</div>
	);
}

function TopicItem({
	now,
	onOpen,
	snapshot,
	thread,
}: {
	now: number;
	onOpen: () => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const author =
		thread.lastMessageRole === "user"
			? "You"
			: (wikiAgent(snapshot, thread.agentIds[0])?.name ?? "Agent");
	return (
		<li className="pt-4">
			<h2 className="border-border border-b pb-1 font-normal font-serif text-[22px] leading-8">
				<button
					className={cn(LINK, "cursor-pointer text-left")}
					onClick={onOpen}
					type="button"
				>
					{wikiThreadTitle(thread)}
				</button>
			</h2>
			<p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground leading-5">
				<span>Latest comment: {wikiAgo(thread.updatedAt, now)}</span>
				<Dot />
				<span>{plural(thread.messageCount, "comment")}</span>
				<Dot />
				<span className="inline-flex items-center gap-1.5">
					<BoardStatusDot status={status} />
					{THREAD_STATUS_LABELS[status]}
				</span>
			</p>
			{thread.lastMessage ? (
				<p className="mt-2 line-clamp-2 text-sm leading-6">
					{thread.lastMessage}{" "}
					<span className="text-muted-foreground">
						&mdash; {author}, {wikiAgo(thread.updatedAt, now)}
					</span>
				</p>
			) : null}
		</li>
	);
}
