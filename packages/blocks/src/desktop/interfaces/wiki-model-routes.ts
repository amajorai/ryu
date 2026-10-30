import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Routes: every page the wiki can show
// ---------------------------------------------------------------------------

export type WikiIndex = "agents" | "projects" | "teams" | "threads";

export type WikiRoute =
	| { kind: "agent"; id: string }
	| { kind: "changes" }
	| { kind: "group"; id: string }
	| { kind: "index"; index: WikiIndex }
	| { kind: "main" }
	| { kind: "search"; query: string }
	| { kind: "thread"; id: string };

/** Article / Talk on the left of the toolbar, Read / View history on the right. */
export type WikiTab = "article" | "history" | "talk";

export const WIKI_MAIN: WikiRoute = { kind: "main" };

export const WIKI_INDEX_ORDER: readonly WikiIndex[] = [
	"agents",
	"teams",
	"projects",
	"threads",
];

/** Labels in the main menu's Contents group. */
export const WIKI_INDEX_LABELS: Record<WikiIndex, string> = {
	agents: "Agents",
	projects: "Projects",
	teams: "Teams",
	threads: "Threads",
};

export function sameRoute(a: WikiRoute, b: WikiRoute): boolean {
	if (a.kind !== b.kind) {
		return false;
	}
	switch (a.kind) {
		case "agent":
		case "group":
		case "thread":
			return a.id === (b as typeof a).id;
		case "index":
			return a.index === (b as typeof a).index;
		case "search":
			return a.query === (b as typeof a).query;
		default:
			return true;
	}
}

/** Whether a page has Talk and history tabs (articles do; special pages do not). */
export function routeHasTalk(route: WikiRoute): boolean {
	return (
		route.kind === "agent" ||
		route.kind === "group" ||
		route.kind === "main" ||
		route.kind === "thread"
	);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export function wikiAgent(
	snapshot: InterfaceSnapshot,
	id: string | null | undefined
): InterfaceAgent | undefined {
	return id ? snapshot.agents.find((agent) => agent.id === id) : undefined;
}

export function wikiGroup(
	snapshot: InterfaceSnapshot,
	id: string | null | undefined
): InterfaceGroup | undefined {
	return id ? snapshot.groups.find((group) => group.id === id) : undefined;
}

export function wikiThread(
	snapshot: InterfaceSnapshot,
	id: string | null | undefined
): InterfaceThread | undefined {
	return id ? snapshot.threads.find((thread) => thread.id === id) : undefined;
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export function byName(a: { name: string }, b: { name: string }): number {
	return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

/** A route's display title, as the page heading shows it. */
export function wikiRouteTitle(
	snapshot: InterfaceSnapshot,
	route: WikiRoute
): string {
	switch (route.kind) {
		case "agent":
			return wikiAgent(snapshot, route.id)?.name ?? "Missing agent";
		case "group":
			return wikiGroup(snapshot, route.id)?.name ?? "Missing page";
		case "thread":
			return wikiThreadTitle(wikiThread(snapshot, route.id));
		case "index":
			return route.index === "threads"
				? "List of threads"
				: `Category:${WIKI_INDEX_LABELS[route.index]}`;
		case "changes":
			return "Recent changes";
		case "search":
			return "Search results";
		default:
			return "Main Page";
	}
}

export function wikiThreadTitle(thread: InterfaceThread | undefined): string {
	return thread?.title.trim() || "Untitled thread";
}

/** The heading for a route on a given tab ("Talk:Atlas", "Atlas: Revision history"). */
export function wikiPageHeading(
	snapshot: InterfaceSnapshot,
	route: WikiRoute,
	tab: WikiTab
): string {
	const title = wikiRouteTitle(snapshot, route);
	if (!routeHasTalk(route)) {
		return title;
	}
	if (tab === "talk") {
		return `Talk:${title}`;
	}
	if (tab === "history") {
		return `${title}: Revision history`;
	}
	return title;
}
