import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	type WikiAgentArticle,
	type WikiGroupArticle,
	type WikiThreadArticle,
	wikiAgentArticle,
	wikiThreadArticle,
} from "./wiki-model-articles.ts";
import { groupLink, link, type WikiSegment } from "./wiki-model-prose.ts";
import { type WikiRoute, wikiGroup } from "./wiki-model-routes.ts";

// ---------------------------------------------------------------------------
// Sections (the table of contents)
// ---------------------------------------------------------------------------

export interface WikiSection {
	id: string;
	label: string;
}

export function agentSections(article: WikiAgentArticle): WikiSection[] {
	const sections: WikiSection[] = [{ id: "threads", label: "Threads" }];
	if (article.collaborators.length > 0) {
		sections.push({ id: "collaborators", label: "Collaborators" });
	}
	if (article.teams.length + article.projects.length > 0) {
		sections.push({ id: "teams", label: "Teams and projects" });
	}
	if (article.pastRuns.length + article.upcomingRuns.length > 0) {
		sections.push({ id: "runs", label: "Scheduled runs" });
	}
	sections.push({ id: "see-also", label: "See also" });
	return sections;
}

export function groupSections(article: WikiGroupArticle): WikiSection[] {
	const sections: WikiSection[] = [
		{ id: "members", label: "Members" },
		{ id: "threads", label: "Threads" },
	];
	if (article.related.length > 0 || article.members.length > 0) {
		sections.push({ id: "see-also", label: "See also" });
	}
	return sections;
}

export function threadSections(article: WikiThreadArticle): WikiSection[] {
	const sections: WikiSection[] = [];
	if (article.thread.lastMessage) {
		sections.push({ id: "latest", label: "Latest message" });
	}
	sections.push({ id: "participants", label: "Participants" });
	if (article.related.length > 0) {
		sections.push({ id: "see-also", label: "See also" });
	}
	return sections;
}

/** Status label for infoboxes and tables. */
export function statusLabel(thread: InterfaceThread): string {
	return THREAD_STATUS_LABELS[threadStatus(thread)];
}

/** The categories a page sits in, for the catlinks box at the foot. */
export function pageCategories(
	snapshot: InterfaceSnapshot,
	route: WikiRoute
): WikiSegment[] {
	const agentsIndex = link({ index: "agents", kind: "index" }, "Agents");
	switch (route.kind) {
		case "agent": {
			const article = wikiAgentArticle(snapshot, route.id);
			if (!article) {
				return [];
			}
			const extra = [...article.teams, ...article.projects]
				.filter((group) => group.memberAgentIds.includes(route.id))
				.map((group) => groupLink(group));
			return [agentsIndex, ...extra];
		}
		case "group": {
			const group = wikiGroup(snapshot, route.id);
			if (!group) {
				return [];
			}
			return [
				link(
					{
						index: group.kind === "team" ? "teams" : "projects",
						kind: "index",
					},
					group.kind === "team" ? "Teams" : "Projects"
				),
			];
		}
		case "thread": {
			const article = wikiThreadArticle(snapshot, route.id);
			if (!article) {
				return [];
			}
			const home = [article.project, article.team]
				.filter((group) => group !== undefined)
				.map(groupLink);
			return [link({ index: "threads", kind: "index" }, "Threads"), ...home];
		}
		default:
			return [];
	}
}
