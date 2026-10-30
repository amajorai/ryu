import { useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { BoardStatusDot } from "./board-status.tsx";
import {
	agentRoute,
	Comma,
	LIST,
	Missing,
	NOTE,
	RunList,
	ThreadLine,
} from "./wiki-articles-shared.tsx";
import {
	agentLeadActivity,
	agentLeadIntro,
	agentSections,
	countWord,
	pageCategories,
	plural,
	wikiAgentArticle,
	wikiAgo,
	wikiStamp,
} from "./wiki-model.ts";
import {
	CatLinks,
	Infobox,
	InfoboxHeader,
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
// Agent
// ---------------------------------------------------------------------------

export function AgentArticle({
	agentId,
	now,
	snapshot,
}: {
	agentId: string;
	now: number;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const article = wikiAgentArticle(snapshot, agentId);
	if (!article) {
		return <Missing noun="agent" />;
	}
	const { agent, collaborators, counts, teams, projects, threads } = article;
	const groups = [...teams, ...projects];
	const runs = [...article.upcomingRuns, ...article.pastRuns];
	return (
		<>
			<Infobox
				caption={agent.name}
				image={<WikiPortrait agent={agent} size={176} />}
				imageCaption={agent.description || undefined}
				kind="Agent"
			>
				<InfoboxRow label="Status">
					<span className="inline-flex items-center gap-1.5">
						<BoardStatusDot
							status={agent.status === "working" ? "working" : "quiet"}
						/>
						{agent.status === "working" ? "Working" : "Idle"}
					</span>
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
				{teams.length > 0 ? (
					<InfoboxRow label={teams.length === 1 ? "Team" : "Teams"}>
						<Comma
							items={teams.map((group) => (
								<WikiLink
									key={group.id}
									route={{ id: group.id, kind: "group" }}
								>
									{group.name}
								</WikiLink>
							))}
						/>
					</InfoboxRow>
				) : null}
				{projects.length > 0 ? (
					<InfoboxRow label={projects.length === 1 ? "Project" : "Projects"}>
						<Comma
							items={projects.map((group) => (
								<WikiLink
									key={group.id}
									route={{ id: group.id, kind: "group" }}
								>
									{group.name}
								</WikiLink>
							))}
						/>
					</InfoboxRow>
				) : null}
				<InfoboxRow label="Last active">
					{article.lastActive ? wikiAgo(article.lastActive, now) : "Never"}
				</InfoboxRow>
				{article.upcomingRuns[0] ? (
					<>
						<InfoboxHeader>Schedule</InfoboxHeader>
						<InfoboxRow label="Next run">
							{article.upcomingRuns[0].title}
							<span className="block text-muted-foreground">
								{wikiAgo(article.upcomingRuns[0].start, now)}
							</span>
						</InfoboxRow>
					</>
				) : null}
			</Infobox>
			<p className={PROSE}>
				<WikiText segments={agentLeadIntro(article)} />
			</p>
			<p className={`${PROSE} mt-3`}>
				<WikiText segments={agentLeadActivity(article, now)} />
			</p>
			<WikiToc sections={agentSections(article)} />

			<WikiSectionHeading id="threads">Threads</WikiSectionHeading>
			{threads.length > 0 ? (
				<ul className={LIST}>
					{threads.map((thread) => (
						<ThreadLine
							key={thread.id}
							now={now}
							snapshot={snapshot}
							thread={thread}
						/>
					))}
				</ul>
			) : (
				<p className={NOTE}>
					{tl("{name} has not taken part in a thread yet.", {
						name: agent.name,
					})}
				</p>
			)}

			{collaborators.length > 0 ? (
				<>
					<WikiSectionHeading id="collaborators">
						Collaborators
					</WikiSectionHeading>
					<p className={`${PROSE} mb-2`}>
						{tl(
							"{name} has worked alongside {count, plural, one {{countText} other agent} other {{countText} other agents}}.",
							{
								count: collaborators.length,
								countText: countWord(collaborators.length),
								name: agent.name,
							}
						)}
					</p>
					<ul className={LIST}>
						{collaborators.map((entry) => (
							<li key={entry.agent.id}>
								<WikiLink route={agentRoute(entry.agent)}>
									{entry.agent.name}
								</WikiLink>
								<span className="text-muted-foreground">
									{" "}
									&ndash;{" "}
									{[
										entry.shared > 0
											? plural(entry.shared, "shared thread")
											: null,
										entry.sharedGroups > 0
											? plural(
													entry.sharedGroups,
													"shared team or project",
													"shared teams or projects"
												)
											: null,
									]
										.filter(Boolean)
										.join(", ")}
								</span>
							</li>
						))}
					</ul>
				</>
			) : null}

			{groups.length > 0 ? (
				<>
					<WikiSectionHeading id="teams">Teams and projects</WikiSectionHeading>
					<ul className={LIST}>
						{groups.map((group) => {
							const member = group.memberAgentIds.includes(agent.id);
							return (
								<li key={group.id}>
									<WikiLink route={{ id: group.id, kind: "group" }}>
										{group.name}
									</WikiLink>
									<span className="text-muted-foreground">
										{" "}
										&ndash; {group.kind === "team" ? "team" : "project"}
										{member ? ", member" : ", contributes to its threads"}
									</span>
								</li>
							);
						})}
					</ul>
				</>
			) : null}

			{runs.length > 0 ? (
				<>
					<WikiSectionHeading id="runs">Scheduled runs</WikiSectionHeading>
					<RunList events={runs} now={now} />
				</>
			) : null}

			<WikiSectionHeading id="see-also">See also</WikiSectionHeading>
			<ul className={LIST}>
				<li>
					<WikiLink route={{ index: "agents", kind: "index" }}>
						Category:Agents
					</WikiLink>
				</li>
				<li>
					<WikiLink route={{ index: "threads", kind: "index" }}>
						List of threads
					</WikiLink>
				</li>
				{collaborators[0] ? (
					<li>
						<WikiLink route={agentRoute(collaborators[0].agent)}>
							{collaborators[0].agent.name}
						</WikiLink>
						<span className="text-muted-foreground">
							, closest collaborator
						</span>
					</li>
				) : null}
			</ul>
			<CatLinks segments={pageCategories(snapshot, agentRoute(agent))} />
			<WikiFooter
				edited={article.lastActive ? wikiStamp(article.lastActive) : null}
			/>
		</>
	);
}
