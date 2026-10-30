import type {
	CommunityPost,
	CommunitySort,
	CommunityVote,
} from "./community-model.ts";

/** Score with the user's own vote applied. */
export function displayScore(
	post: CommunityPost,
	vote: CommunityVote | undefined
): number {
	return post.score + (vote ?? 0);
}

/** Reddit's epoch for hot ranking (Dec 8, 2005). */
const HOT_EPOCH_SECONDS = 1_134_028_003;
/** Seconds that equal one order of magnitude of score. */
const HOT_DECAY_SECONDS = 45_000;

/**
 * Reddit's hot rank: the log of the score plus time, so a post needs ten
 * times the score to hold its place against one 12.5 hours newer.
 */
export function hotRank(score: number, iso: string): number {
	const time = Date.parse(iso);
	const seconds = Number.isNaN(time) ? 0 : time / 1000 - HOT_EPOCH_SECONDS;
	const order = Math.log10(Math.max(Math.abs(score), 1));
	const sign = Math.sign(score);
	return sign * order + seconds / HOT_DECAY_SECONDS;
}

function byRecency(a: CommunityPost, b: CommunityPost): number {
	return (
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

/**
 * Orders posts. Votes never reorder a feed while the user is looking at it,
 * so ranking reads the base score only. Pinned posts lead a community's Hot
 * feed, the way stickied posts do.
 */
export function sortPosts(
	posts: readonly CommunityPost[],
	sort: CommunitySort,
	pinPinned = false
): CommunityPost[] {
	const ranked = [...posts];
	switch (sort) {
		case "new":
			ranked.sort(byRecency);
			break;
		case "top":
			ranked.sort((a, b) => b.score - a.score || byRecency(a, b));
			break;
		default:
			ranked.sort(
				(a, b) =>
					(pinPinned ? Number(b.thread.pinned) - Number(a.thread.pinned) : 0) ||
					hotRank(b.score, b.thread.updatedAt) -
						hotRank(a.score, a.thread.updatedAt) ||
					byRecency(a, b)
			);
	}
	return ranked;
}
