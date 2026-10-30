import { useState } from "react";
import type { PostActions } from "./community-feed.tsx";
import { type CommunityVote, nextVote } from "./community-model.ts";

/** Local votes and saves on posts, with the actions that toggle them. */
export function usePostReactions(): Pick<
	PostActions,
	"onSave" | "onVote" | "saved" | "votes"
> {
	const [votes, setVotes] = useState<Record<string, CommunityVote>>({});
	const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set());
	return {
		onSave: (threadId) =>
			setSaved((previous) => {
				const next = new Set(previous);
				if (next.has(threadId)) {
					next.delete(threadId);
				} else {
					next.add(threadId);
				}
				return next;
			}),
		onVote: (threadId, vote) =>
			setVotes((previous) => {
				const next = { ...previous };
				const value = nextVote(previous[threadId], vote);
				if (value === undefined) {
					delete next[threadId];
				} else {
					next[threadId] = value;
				}
				return next;
			}),
		saved,
		votes,
	};
}
