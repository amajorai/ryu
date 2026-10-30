import { useLiteralMessages } from "@ryu/i18n/react";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import {
	agentRoute,
	Comma,
	LIST,
	Missing,
	NOTE,
	ThreadLine,
} from "./wiki-articles-shared.tsx";
import {
	countWord,
	groupLead,
	groupSections,
	pageCategories,
	plural,
	wikiAgo,
	wikiGroupArticle,
	wikiStamp,
} from "./wiki-model.ts";
import {
	CatLinks,
	Infobox,
	InfoboxRow,
	PROSE,
	WikiFooter,
	WikiLink,
	WikiPortrait,
	WikiSectionHeading,
	WikiText,
	WikiToc,
} from "./wiki-parts.tsx";

// ---------------------------------------------------------------------------
// Team / project
// ---------------------------------------------------------------------------

/** Square images stay at the portrait size; rows of 2 or 3 use the box width. */
const PORTRAIT = 176;
const ROW_WIDTH = 256;
const GROUP_GAP = 2;

/** Member portraits as one infobox image: a row of up to 3, or a 2 by 2 grid. */
function GroupImage({ members }: { members: InterfaceAgent[] }) {
	const shown = members.slice(0, 4);
	if (shown.length === 0) {
		return null;
	}
	const columns = shown.length === 4 ? 2 : shown.length;
	const width = shown.length === 2 || shown.length === 3 ? ROW_WIDTH : PORTRAIT;
	const tile = Math.floor((width - GROUP_GAP * (columns - 1)) / columns);
	return (
		<span
			className="grid gap-0.5"
			style={{ gridTemplateColumns: `repeat(${columns}, ${tile}px)` }}
		>
			{shown.map((agent) => (
				<WikiPortrait agent={agent} key={agent.id} size={tile} />
			))}
		</span>
	);
}

export function GroupArticle({
	groupId,
	now,
	snapshot,
}: {
	groupId: string;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const article = wikiGroupArticle(snapshot, groupId);
	if (!article) {
		return <Missing noun="team or project" />;
	}
	const { group, members, threads, counts, related } = article;
	const noun = group.kind === "team" ? "Team" : "Project";
	return (
		<>
			<Infobox
				caption={group.name}
				image={
					members.length > 0 ? <GroupImage members={members} /> : undefined
				}
				imageCaption={
					members.length > 0
						? `${members
								.slice(0, 4)
								.map((agent) => agent.name)
								.join(", ")}`
						: undefined
				}
				kind={noun}
			>
				<InfoboxRow label="Members">
					{members.length > 0 ? (
						<Comma
							items={members.map((agent) => (
								<WikiLink key={agent.id} route={agentRoute(agent)}>
									{agent.name}
								</WikiLink>
							))}
						/>
					) : (
						"None"
					)}
				</InfoboxRow>
				<InfoboxRow label="Threads">
					{threads.length.toLocaleString("en")}
					{counts.working > 0 ? (
						<span className="text-muted-foreground">
							{" "}
							{tl("({working} live)", { working: String(counts.working) })}
						</span>
					) : null}
				</InfoboxRow>
				<InfoboxRow label="Messages">
					{article.messages.toLocaleString("en")}
				</InfoboxRow>
				{counts.attention + counts["your-turn"] > 0 ? (
					<InfoboxRow label="Needs you">
						{plural(counts.attention + counts["your-turn"], "thread")}
					</InfoboxRow>
				) : null}
				<InfoboxRow label="Last active">
					{article.lastActive ? wikiAgo(article.lastActive, now) : "Never"}
				</InfoboxRow>
			</Infobox>
			<p className={PROSE}>
				<WikiText segments={groupLead(article, now)} />
			</p>
			<WikiToc sections={groupSections(article)} />

			<WikiSectionHeading id="members">Members</WikiSectionHeading>
			{members.length > 0 ? (
				<ul className={LIST}>
					{members.map((agent) => (
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
				<p className={NOTE}>
					{tl("No agents are assigned to this {noun}.", {
						noun: noun.toLowerCase(),
					})}
				</p>
			)}

			<WikiSectionHeading id="threads">Threads</WikiSectionHeading>
			{threads.length > 0 ? (
				<ul className={LIST}>
					{threads.map((thread) => (
						<ThreadLine
							key={thread.id}
							now={now}
							snapshot={snapshot}
							thread={thread}
							withAgents
						/>
					))}
				</ul>
			) : (
				<p className={NOTE}>
					{tl(
						"No threads are filed under this {noun} yet. Start one from its talk page.",
						{ noun: noun.toLowerCase() }
					)}
				</p>
			)}

			{related.length > 0 || members.length > 0 ? (
				<>
					<WikiSectionHeading id="see-also">See also</WikiSectionHeading>
					<ul className={LIST}>
						{related.map((other) => (
							<li key={other.id}>
								<WikiLink route={{ id: other.id, kind: "group" }}>
									{other.name}
								</WikiLink>
								<span className="text-muted-foreground">
									{tl(", {kind} sharing {count} of its members", {
										count: countWord(
											other.memberAgentIds.filter((id) =>
												group.memberAgentIds.includes(id)
											).length
										),
										kind: other.kind === "team" ? "team" : "project",
									})}
								</span>
							</li>
						))}
						<li>
							<WikiLink
								route={{
									index: group.kind === "team" ? "teams" : "projects",
									kind: "index",
								}}
							>
								{tl("Category:{name}", {
									name: group.kind === "team" ? "Teams" : "Projects",
								})}
							</WikiLink>
						</li>
					</ul>
				</>
			) : null}
			<CatLinks
				segments={pageCategories(snapshot, { id: group.id, kind: "group" })}
			/>
			<WikiFooter
				edited={article.lastActive ? wikiStamp(article.lastActive) : null}
			/>
		</>
	);
}
