import { translate as tr } from "@ryu/i18n/lite";
import type { WikiAgentArticle } from "./wiki-model-articles.ts";
import {
	bold,
	countWord,
	escapeValues,
	groupLink,
	joinSegments,
	lowerFirst,
	richSegments,
	segmentsText,
	text,
	threadLink,
	type WikiSegment,
	wikiAgo,
	wikiCount,
} from "./wiki-model-prose.ts";

/** First lead paragraph: who the agent is and where it belongs. */
export function agentLeadIntro(article: WikiAgentArticle): WikiSegment[] {
	const { agent, teams, projects } = article;
	const description = lowerFirst(agent.description);
	const name = { b: (inner: string) => [bold(inner)] };
	const out = description
		? richSegments(
				tr(
					"<b>{name}</b> is an agent in this workspace, described as “{description}”.",
					escapeValues({ description, name: agent.name })
				),
				name
			)
		: richSegments(
				tr(
					"<b>{name}</b> is an agent in this workspace.",
					escapeValues({ name: agent.name })
				),
				name
			);
	const memberTeams = teams.filter((group) =>
		group.memberAgentIds.includes(agent.id)
	);
	const memberProjects = projects.filter((group) =>
		group.memberAgentIds.includes(agent.id)
	);
	const teamList = joinSegments(memberTeams.map(groupLink));
	const projectList = joinSegments(memberProjects.map(groupLink));
	const values = escapeValues({
		projectCount: memberProjects.length,
		projects: segmentsText(projectList),
		teamCount: memberTeams.length,
		teams: segmentsText(teamList),
	});
	const tags = { projects: () => projectList, teams: () => teamList };
	if (memberTeams.length > 0 && memberProjects.length > 0) {
		out.push(
			text(" "),
			...richSegments(
				tr(
					"It is a member of the <teams>{teams}</teams> {teamCount, plural, one {team} other {teams}} and the <projects>{projects}</projects> {projectCount, plural, one {project} other {projects}}.",
					values
				),
				tags
			)
		);
	} else if (memberTeams.length > 0) {
		out.push(
			text(" "),
			...richSegments(
				tr(
					"It is a member of the <teams>{teams}</teams> {teamCount, plural, one {team} other {teams}}.",
					values
				),
				tags
			)
		);
	} else if (memberProjects.length > 0) {
		out.push(
			text(" "),
			...richSegments(
				tr(
					"It is a member of the <projects>{projects}</projects> {projectCount, plural, one {project} other {projects}}.",
					values
				),
				tags
			)
		);
	}
	return out;
}

/** Second lead paragraph: activity in numbers. */
export function agentLeadActivity(
	article: WikiAgentArticle,
	now: number
): WikiSegment[] {
	const { agent, threads, counts, messages } = article;
	const latest = threads[0];
	if (!latest) {
		return [
			text(
				tr(
					"{name} has not taken part in any threads yet. Its talk page is where to start one.",
					{ name: agent.name }
				)
			),
		];
	}
	const latestLink = threadLink(latest);
	const out = richSegments(
		tr(
			"{name} has taken part in {threads}, with {messages} in all. Its most recent is <latest>{latest}</latest>, updated {ago}.",
			escapeValues({
				ago: wikiAgo(latest.updatedAt, now),
				latest: latestLink.text,
				messages: wikiCount(messages, "message"),
				name: agent.name,
				threads: wikiCount(threads.length, "thread"),
			})
		),
		{ latest: () => [latestLink] }
	);
	const notes: string[] = [];
	if (counts.working > 0) {
		notes.push(
			tr("it is working on {threads}", {
				threads: wikiCount(counts.working, "thread"),
			})
		);
	}
	if (counts["your-turn"] > 0) {
		notes.push(
			tr(
				"{count, plural, one {{n} of its threads is waiting on your reply} other {{n} of its threads are waiting on your reply}}",
				{ count: counts["your-turn"], n: countWord(counts["your-turn"]) }
			)
		);
	}
	if (counts.attention > 0) {
		notes.push(
			tr(
				"{count, plural, one {{n} of its threads needs attention after a stopped run} other {{n} of its threads need attention after a stopped run}}",
				{ count: counts.attention, n: countWord(counts.attention) }
			)
		);
	}
	if (notes.length > 0) {
		out.push(
			text(" "),
			text(
				tr("Right now, {notes}.", {
					notes: segmentsText(joinSegments(notes.map((note) => text(note)))),
				})
			)
		);
	}
	return out;
}
