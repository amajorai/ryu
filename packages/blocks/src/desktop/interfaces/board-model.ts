import type { BoardParams } from "@ryuhq/protocol/interfaces";

/** What the board's body shows. */
export type BoardBodyState = "board" | "empty" | "loading" | "no-matches";

/**
 * Pick the body: skeletons until the first load, the empty state when there
 * is nothing to group (agent lanes still show with no threads), the no-match
 * state when filters hide every thread, and the board otherwise.
 */
export function boardBodyState({
	agentCount,
	filtered,
	groupBy,
	loading,
	shownCount,
	threadCount,
}: {
	agentCount: number;
	filtered: boolean;
	groupBy: BoardParams["groupBy"];
	loading: boolean;
	shownCount: number;
	threadCount: number;
}): BoardBodyState {
	if (loading) {
		return "loading";
	}
	if (threadCount === 0 && (groupBy === "status" || agentCount === 0)) {
		return "empty";
	}
	if (filtered && shownCount === 0) {
		return "no-matches";
	}
	return "board";
}
