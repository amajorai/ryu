import { useRichLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import {
	agentRoute,
	Comma,
	LIST,
	Missing,
	NOTE,
	Status,
	ThreadLine,
	threadRoute,
} from "./wiki-articles-shared.tsx";
import {
	latestAuthor,
	pageCategories,
	threadLead,
	threadSections,
	wikiAgo,
	wikiStamp,
	wikiThreadArticle,
	wikiThreadTitle,
} from "./wiki-model.ts";
import {
	CatLinks,
	Infobox,
	InfoboxRow,
	PROSE,
	WikiFooter,
	WikiLink,
	WikiSectionHeading,
	WikiText,
	WikiToc,
} from "./wiki-parts.tsx";

export { AgentArticle } from "./wiki-articles-agent.tsx";
export { GroupArticle } from "./wiki-articles-group.tsx";

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

export function ThreadArticle({
	now,
	onOpenTalk,
	snapshot,
	threadId,
}: {
	now: number;
	onOpenTalk: () => void;
	snapshot: InterfaceSnapshot;
	threadId: string;
}) {
	const tlRich = useRichLiteralMessages();
	const article = wikiThreadArticle(snapshot, threadId);
	if (!article) {
		return <Missing noun="thread" />;
	}
	const { agents, project, team, thread, related } = article;
	return (
		<>
			<Infobox caption={wikiThreadTitle(thread)} kind="Thread">
				<InfoboxRow label="Status">
					<Status thread={thread} />
				</InfoboxRow>
				<InfoboxRow label={agents.length === 1 ? "Agent" : "Agents"}>
					{agents.length > 0 ? (
						<Comma
							items={agents.map((agent) => (
								<WikiLink key={agent.id} route={agentRoute(agent)}>
									{agent.name}
								</WikiLink>
							))}
						/>
					) : (
						"None assigned"
					)}
				</InfoboxRow>
				{team ? (
					<InfoboxRow label="Team">
						<WikiLink route={{ id: team.id, kind: "group" }}>
							{team.name}
						</WikiLink>
					</InfoboxRow>
				) : null}
				{project ? (
					<InfoboxRow label="Project">
						<WikiLink route={{ id: project.id, kind: "group" }}>
							{project.name}
						</WikiLink>
					</InfoboxRow>
				) : null}
				<InfoboxRow label="Messages">
					{thread.messageCount.toLocaleString("en")}
				</InfoboxRow>
				<InfoboxRow label="Updated">
					{wikiAgo(thread.updatedAt, now)}
					<span className="block text-muted-foreground">
						{wikiStamp(thread.updatedAt)}
					</span>
				</InfoboxRow>
				{thread.pinned ? <InfoboxRow label="Pinned">Yes</InfoboxRow> : null}
			</Infobox>
			<p className={PROSE}>
				<WikiText segments={threadLead(article, now)} />
			</p>
			<WikiToc sections={threadSections(article)} />

			{thread.lastMessage ? (
				<>
					<WikiSectionHeading id="latest">Latest message</WikiSectionHeading>
					<figure>
						<blockquote className="border-border border-l-2 pl-4 font-serif text-[15px] text-foreground leading-6">
							{thread.lastMessage}
						</blockquote>
						<figcaption className="mt-2 pl-4 text-muted-foreground text-sm leading-6">
							{tlRich(
								"— {author}, {ago}. <button>Read the full conversation</button>",
								{
									ago: wikiAgo(thread.updatedAt, now),
									author: latestAuthor(article),
								},
								{
									button: (chunks) => (
										<button
											className="cursor-pointer rounded-[2px] text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
											onClick={onOpenTalk}
											type="button"
										>
											{chunks}
										</button>
									),
								}
							)}
						</figcaption>
					</figure>
				</>
			) : null}

			<WikiSectionHeading id="participants">Participants</WikiSectionHeading>
			{agents.length > 0 ? (
				<ul className={LIST}>
					{agents.map((agent) => (
						<li key={agent.id}>
							<WikiLink route={agentRoute(agent)}>{agent.name}</WikiLink>
							{agent.description ? (
								<span className="text-muted-foreground">
									{" "}
									&ndash; {agent.description}
								</span>
							) : null}
						</li>
					))}
				</ul>
			) : (
				<p className={NOTE}>No agent is assigned to this thread.</p>
			)}

			{related.length > 0 ? (
				<>
					<WikiSectionHeading id="see-also">See also</WikiSectionHeading>
					<ul className={LIST}>
						{related.map((other) => (
							<ThreadLine
								key={other.id}
								now={now}
								snapshot={snapshot}
								thread={other}
							/>
						))}
					</ul>
				</>
			) : null}
			<CatLinks segments={pageCategories(snapshot, threadRoute(thread))} />
			<WikiFooter edited={wikiStamp(thread.updatedAt)} />
		</>
	);
}
