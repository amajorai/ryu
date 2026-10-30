import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	agentRevisions,
	changesByDay,
	eventOutcome,
	plural,
	threadRevisions,
	type WikiRevision,
	type WikiRoute,
	wikiAgent,
	wikiAgentArticle,
	wikiGroupArticle,
	wikiStamp,
	wikiThreadArticle,
	wikiThreadTitle,
	wikiTime,
} from "./wiki-model.ts";
import { PROSE, WikiFooter, WikiLink } from "./wiki-parts.tsx";

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
	const tl = useLiteralMessages();
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
					{tl("(scheduled run, {outcome})", { outcome: eventOutcome(event) })}
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
