import type { Community } from "./community-model.ts";
import { PROFILE_KEY } from "./community-model-keys.ts";

export const TITLE_LIMIT = 300;

export interface CommunityDraft {
	body: string;
	/** The chosen community's key, or null before one is picked. */
	communityKey: string | null;
	title: string;
}

export function emptyDraft(communityKey: string | null = null): CommunityDraft {
	return { body: "", communityKey, title: "" };
}

/** The one message a post sends: its title, then any body text. */
export function draftPrompt(draft: CommunityDraft): string {
	const title = draft.title.trim().slice(0, TITLE_LIMIT);
	const body = draft.body.trim();
	if (!title) {
		return "";
	}
	return body ? `${title}\n\n${body}` : title;
}

export interface CommunityStartInput {
	agentId?: string;
	projectId?: string;
	prompt?: string;
	teamId?: string;
}

/** Port input that files a new thread in a community. */
export function communityTarget(community: Community): CommunityStartInput {
	switch (community.kind) {
		case "project":
			return { projectId: community.sourceId };
		case "team":
			return { teamId: community.sourceId };
		case "agent":
			return { agentId: community.sourceId };
		default:
			return {};
	}
}

/** The port call for a draft, or null until it has a title and a community. */
export function draftStartInput(
	draft: CommunityDraft,
	communities: readonly Community[]
): CommunityStartInput | null {
	const prompt = draftPrompt(draft);
	const community = draft.communityKey
		? communities.find((candidate) => candidate.key === draft.communityKey)
		: undefined;
	if (!(prompt && (community || draft.communityKey === PROFILE_KEY))) {
		return null;
	}
	return { ...(community ? communityTarget(community) : {}), prompt };
}

/** Port input for "Message": an empty thread with one agent, filed here. */
export function messageInput(
	community: Community,
	agentId: string
): CommunityStartInput {
	if (community.kind === "project") {
		return { agentId, projectId: community.sourceId };
	}
	if (community.kind === "team") {
		return { agentId, teamId: community.sourceId };
	}
	return { agentId };
}
