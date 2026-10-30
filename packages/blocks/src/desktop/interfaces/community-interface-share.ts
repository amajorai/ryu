import { useEffect, useRef, useState } from "react";
import { type CommunityPost, communityLabel } from "./community-model.ts";

const COPIED_MS = 1600;

/** Copies a post's title and community, flagging it as copied for a moment. */
export function useCopiedShare(): {
	copiedId: string | null;
	share: (post: CommunityPost) => void;
} {
	const copiedTimer = useRef<number | null>(null);
	const [copiedId, setCopiedId] = useState<string | null>(null);

	useEffect(
		() => () => {
			if (copiedTimer.current !== null) {
				window.clearTimeout(copiedTimer.current);
			}
		},
		[]
	);

	const share = (post: CommunityPost) => {
		const text = `${post.thread.title} (${communityLabel(post.community)})`;
		try {
			navigator.clipboard?.writeText(text).catch(() => undefined);
		} catch {
			// Clipboard access can be denied; the label still confirms the action.
		}
		setCopiedId(post.thread.id);
		if (copiedTimer.current !== null) {
			window.clearTimeout(copiedTimer.current);
		}
		copiedTimer.current = window.setTimeout(() => {
			setCopiedId(null);
			copiedTimer.current = null;
		}, COPIED_MS);
	};

	return { copiedId, share };
}
