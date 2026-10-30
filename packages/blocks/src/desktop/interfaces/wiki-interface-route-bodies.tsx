import { useLiteralMessages, useRichLiteralMessages } from "@ryu/i18n/react";
import type { ReactNode } from "react";
import type { InterfaceRendererProps } from "./interface-renderer.ts";
import { AgentArticle, GroupArticle, ThreadArticle } from "./wiki-articles.tsx";
import {
	byRecency,
	type WikiRoute,
	wikiAgent,
	wikiGroup,
	wikiRouteTitle,
	wikiThread,
} from "./wiki-model.ts";
import {
	CategoryPage,
	MainPage,
	RecentChangesPage,
	SearchPage,
	TalkPage,
	ThreadListPage,
} from "./wiki-pages.tsx";

// ---------------------------------------------------------------------------
// Route bodies
// ---------------------------------------------------------------------------

export function RouteArticle({
	now,
	onOpenTalk,
	onSearch,
	onStart,
	route,
	snapshot,
}: {
	now: number;
	onOpenTalk: () => void;
	onSearch: (query: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	route: WikiRoute;
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
}) {
	switch (route.kind) {
		case "agent":
			return (
				<div className="pt-4">
					<AgentArticle agentId={route.id} now={now} snapshot={snapshot} />
				</div>
			);
		case "group":
			return (
				<div className="pt-4">
					<GroupArticle groupId={route.id} now={now} snapshot={snapshot} />
				</div>
			);
		case "thread":
			return (
				<div className="pt-4">
					<ThreadArticle
						now={now}
						onOpenTalk={onOpenTalk}
						snapshot={snapshot}
						threadId={route.id}
					/>
				</div>
			);
		case "index":
			return route.index === "threads" ? (
				<ThreadListPage now={now} snapshot={snapshot} />
			) : (
				<CategoryPage index={route.index} snapshot={snapshot} />
			);
		case "changes":
			return <RecentChangesPage snapshot={snapshot} />;
		case "search":
			return (
				<SearchPage
					key={route.query}
					onSearch={onSearch}
					query={route.query}
					snapshot={snapshot}
				/>
			);
		default:
			return <MainPage now={now} onStart={onStart} snapshot={snapshot} />;
	}
}

export function RouteTalk({
	now,
	onOpenThread,
	onStart,
	route,
	snapshot,
}: {
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	route: WikiRoute;
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
}) {
	const tlRich = useRichLiteralMessages();
	const title = wikiRouteTitle(snapshot, route);
	if (route.kind === "agent") {
		const agent = wikiAgent(snapshot, route.id);
		return (
			<TalkPage
				intro={tlRich(
					"This is the talk page for <b>{title}</b>. Each topic is a thread with {title}; adding a topic sends its first message to {hasAgent, select, yes {{title}} other {the agent}} right away.",
					{ hasAgent: agent ? "yes" : "no", title },
					{ b: (chunks) => <b className="font-semibold">{chunks}</b> }
				)}
				now={now}
				onOpenThread={onOpenThread}
				onStart={onStart}
				pageTitle={title}
				snapshot={snapshot}
				threads={snapshot.threads
					.filter((thread) => thread.agentIds.includes(route.id))
					.sort(byRecency)}
			/>
		);
	}
	if (route.kind === "group") {
		const group = wikiGroup(snapshot, route.id);
		const noun = group?.kind === "team" ? "team" : "project";
		return (
			<TalkPage
				intro={tlRich(
					"This is the talk page for the <b>{title}</b> {noun, select, team {team} other {project}}. Each topic is a thread filed under it; adding a topic starts one right away.",
					{ noun, title },
					{ b: (chunks) => <b className="font-semibold">{chunks}</b> }
				)}
				now={now}
				onOpenThread={onOpenThread}
				onStart={onStart}
				pageTitle={title}
				snapshot={snapshot}
				threads={snapshot.threads
					.filter((thread) =>
						group?.kind === "team"
							? thread.teamId === route.id
							: thread.projectId === route.id
					)
					.sort(byRecency)}
			/>
		);
	}
	return (
		<TalkPage
			agents={snapshot.agents}
			intro={
				<>
					This is the talk page for the{" "}
					<b className="font-semibold">Main Page</b>. Topics here are threads
					not assigned to an agent; adding a topic starts a thread right away.
				</>
			}
			now={now}
			onOpenThread={onOpenThread}
			onStart={onStart}
			pageTitle="the workspace"
			snapshot={snapshot}
			threads={snapshot.threads
				.filter((thread) => thread.agentIds.length === 0)
				.sort(byRecency)}
		/>
	);
}

/** A thread's Talk tab: the host's own conversation surface, framed. */
export function ChatTalk({
	snapshot,
	threadId,
	threadView,
}: {
	snapshot: InterfaceRendererProps<Record<string, never>>["snapshot"];
	threadId: string | null;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const thread = wikiThread(snapshot, threadId);
	const names = (thread?.agentIds ?? [])
		.map((id) => wikiAgent(snapshot, id)?.name)
		.filter((name) => name !== undefined);
	const home =
		wikiGroup(snapshot, thread?.projectId) ??
		wikiGroup(snapshot, thread?.teamId);
	let note = "A new conversation. Your first message starts the thread.";
	if (thread) {
		const agentNames = names.join(", ");
		if (names.length > 0) {
			note = home
				? tl("Conversation with {agentNames}, filed under {home}.", {
						agentNames,
						home: home.name,
					})
				: tl("Conversation with {agentNames}.", { agentNames });
		} else {
			note = home
				? tl("Conversation filed under {home}.", { home: home.name })
				: tl("Conversation.");
		}
	}
	return (
		<>
			<p className="mt-1 mb-3 text-[13px] text-muted-foreground leading-5">
				{note}
			</p>
			<div
				className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border"
				data-testid="wiki-talk-thread"
			>
				{threadView}
			</div>
		</>
	);
}
