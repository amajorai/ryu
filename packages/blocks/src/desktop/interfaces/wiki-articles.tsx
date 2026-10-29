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
	agentLeadActivity,
	agentLeadIntro,
	agentSections,
	countWord,
	eventOutcome,
	groupLead,
	groupSections,
	latestAuthor,
	pageCategories,
	plural,
	threadLead,
	threadSections,
	type WikiRoute,
	wikiAgentArticle,
	wikiAgo,
	wikiGroupArticle,
	wikiStamp,
	wikiThreadArticle,
	wikiThreadTitle,
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

const LIST =
	"list-disc space-y-1 pl-6 text-sm leading-6 marker:text-muted-foreground";
const NOTE = "text-muted-foreground text-sm leading-6";

function Status({ thread }: { thread: InterfaceThread }) {
	const status = threadStatus(thread);
	return (
		<span className="inline-flex items-center gap-1.5">
			<BoardStatusDot status={status} />
			{THREAD_STATUS_LABELS[status]}
		</span>
	);
}

function Comma({ items }: { items: ReactNode[] }) {
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

function agentRoute(agent: InterfaceAgent): WikiRoute {
	return { id: agent.id, kind: "agent" };
}

function threadRoute(thread: InterfaceThread): WikiRoute {
	return { id: thread.id, kind: "thread" };
}

/** One thread as a list line: link, then plain facts in the reference's voice. */
function ThreadLine({
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
				({plural(thread.messageCount, "message")}, updated{" "}
				{wikiAgo(thread.updatedAt, now)}
				{status === "quiet"
					? ""
					: `; ${THREAD_STATUS_LABELS[status].toLowerCase()}`}
				)
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

function RunList({ events, now }: { events: InterfaceEvent[]; now: number }) {
	return (
		<ul className={LIST}>
			{events.map((event) => (
				<li key={event.id}>
					{runLine(event)}
					<span className="text-muted-foreground">
						{" "}
						&ndash;{" "}
						{event.kind === "upcoming"
							? `next run ${wikiAgo(event.start, now)}`
							: `${eventOutcome(event)} ${wikiAgo(event.start, now)}`}
						{event.count && event.count > 1 ? ` (${event.count} runs)` : ""}
					</span>
				</li>
			))}
		</ul>
	);
}

function Missing({ noun }: { noun: string }) {
	return (
		<div className="pt-4">
			<p className={PROSE}>
				The wiki does not have a {noun} with this name. It may have been deleted
				or renamed.
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
							({counts.working} live)
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
				<p className={NOTE}>{agent.name} has not taken part in a thread yet.</p>
			)}

			{collaborators.length > 0 ? (
				<>
					<WikiSectionHeading id="collaborators">
						Collaborators
					</WikiSectionHeading>
					<p className={`${PROSE} mb-2`}>
						{agent.name} has worked alongside{" "}
						{plural(collaborators.length, "other agent")}.
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
							({counts.working} live)
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
					No agents are assigned to this {noun.toLowerCase()}.
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
					No threads are filed under this {noun.toLowerCase()} yet. Start one
					from its talk page.
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
									, {other.kind === "team" ? "team" : "project"} sharing{" "}
									{countWord(
										other.memberAgentIds.filter((id) =>
											group.memberAgentIds.includes(id)
										).length
									)}{" "}
									of its members
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
								Category:{group.kind === "team" ? "Teams" : "Projects"}
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
							&mdash; {latestAuthor(article)}, {wikiAgo(thread.updatedAt, now)}.{" "}
							<button
								className="cursor-pointer rounded-[2px] text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
								onClick={onOpenTalk}
								type="button"
							>
								Read the full conversation
							</button>
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
