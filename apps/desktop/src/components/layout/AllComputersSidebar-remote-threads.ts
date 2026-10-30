// Folder grouping for a remote computer's threads in the "All computers" sidebar.

import type { Conversation } from "@/types/chat.ts";

const PATH_SEP_RE = /[\\/]/;
const TRAILING_SEPARATORS_RE = /[\\/]+$/;

/** Folder leaf as a label. Another computer's paths are never matched against
 *  this computer's projects (a Windows path seen from a Mac means nothing
 *  here), so the folder's own name is the only honest label. */
function folderLeaf(path: string): string {
	const trimmed = path.replace(TRAILING_SEPARATORS_RE, "");
	return trimmed.split(PATH_SEP_RE).pop() || trimmed || path;
}

export interface RemoteFolderGroup {
	conversations: Conversation[];
	key: string;
	name: string;
}

/** Group a remote computer's threads by folder; folderless threads are loose.
 *  Spawned sessions are left out, as they are behind their main thread in the
 *  regular sidebar. Newest first within each bucket. */
export function groupRemoteThreads(conversations: readonly Conversation[]): {
	folders: RemoteFolderGroup[];
	loose: Conversation[];
} {
	const byNewest = [...conversations]
		.filter((c) => !c.hierarchy?.spawnedByConversationId)
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const folders = new Map<string, RemoteFolderGroup>();
	const loose: Conversation[] = [];
	for (const conversation of byNewest) {
		if (!conversation.folderPath) {
			loose.push(conversation);
			continue;
		}
		const key = conversation.folderPath.replace(TRAILING_SEPARATORS_RE, "");
		const bucket = folders.get(key);
		if (bucket) {
			bucket.conversations.push(conversation);
		} else {
			folders.set(key, {
				key,
				name: folderLeaf(conversation.folderPath),
				conversations: [conversation],
			});
		}
	}
	return { folders: [...folders.values()], loose };
}
