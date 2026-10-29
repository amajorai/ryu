// apps/desktop/src/store/useChatPullRequestIndex.ts
//
// Remembers which pull request each chat's branch owns, so chat search can
// match a pull request number without asking GitHub on every keystroke.
// Explicit links live on the Core conversation (`linkedPullRequests`); this
// index only covers the implicit branch pull request, recorded whenever the
// sidebar or the pull request watcher resolves it. Local-only and best-effort:
// a cleared index just means branch pull requests are searchable again once
// they are looked up.

import { z } from "zod";
import { create } from "zustand";
import { parsePullRequestUrl } from "@/src/lib/api/pull-requests.ts";

const STORAGE_KEY = "ryu:chat-branch-pull-requests";
/** Pull requests remembered per chat (a branch can be reused over time). */
const MAX_PER_CHAT = 5;
const MAX_CHATS = 2000;

const storedIndexSchema = z.record(z.string(), z.array(z.string()));

function loadIndex(): Record<string, string[]> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		const parsed = storedIndexSchema.safeParse(raw ? JSON.parse(raw) : {});
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

function saveIndex(index: Record<string, string[]>) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(index));
	} catch {
		// best-effort
	}
}

interface ChatPullRequestIndexState {
	/** Chat id → canonical pull request URLs its branch has owned. */
	branchPullRequests: Record<string, string[]>;
	record: (conversationId: string, url: string) => void;
}

export const useChatPullRequestIndex = create<ChatPullRequestIndexState>(
	(set) => ({
		branchPullRequests: loadIndex(),
		record: (conversationId, url) =>
			set((state) => {
				const canonical = parsePullRequestUrl(url)?.url;
				const current = state.branchPullRequests[conversationId] ?? [];
				if (!(conversationId && canonical) || current.includes(canonical)) {
					return state;
				}
				const entries = Object.entries({
					...state.branchPullRequests,
					[conversationId]: [...current, canonical].slice(-MAX_PER_CHAT),
				});
				const branchPullRequests = Object.fromEntries(
					entries.slice(-MAX_CHATS)
				);
				saveIndex(branchPullRequests);
				return { branchPullRequests };
			}),
	})
);

/** Record a chat's branch pull request from outside React. */
export function recordChatBranchPullRequest(
	conversationId: string,
	url: string
): void {
	useChatPullRequestIndex.getState().record(conversationId, url);
}
