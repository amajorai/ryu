// apps/desktop/src/lib/sidebar-project-focus.ts
//
// The Discord-style project rail narrows the sidebar to one project, the way a
// server icon narrows Discord to that server's channels. This is the pure
// filter: given the sidebar's bucketed conversations and the focused project
// path, keep only that project's bucket and chats. `null` (Home) keeps all.

import { folderKey } from "@/src/lib/folder-path.ts";
import type { Conversation } from "@/types/chat.ts";

interface FocusableProjectBucket {
	conversations: Conversation[];
	path: string;
	sourceFolders: string[];
}

export interface SidebarProjectBuckets<P extends FocusableProjectBucket> {
	agentModeOtherChats: Conversation[];
	archived: Conversation[];
	pinned: Conversation[];
	projectList: P[];
	rest: Conversation[];
}

/** Narrow the sidebar's buckets to `focusedPath`'s project. Unknown or `null`
 *  focus returns the buckets unchanged, so a removed project never empties the
 *  sidebar. */
export function focusSidebarProjects<
	P extends FocusableProjectBucket,
	B extends SidebarProjectBuckets<P>,
>(buckets: B, focusedPath: string | null): B {
	if (!focusedPath) {
		return buckets;
	}
	const key = folderKey(focusedPath);
	const project = buckets.projectList.find((p) => folderKey(p.path) === key);
	if (!project) {
		return buckets;
	}
	const ids = new Set(project.conversations.map((c) => c.id));
	const folders = new Set(
		[project.path, ...project.sourceFolders].map((path) => folderKey(path))
	);
	const inProject = (c: Conversation) =>
		ids.has(c.id) ||
		(c.folderPath ? folders.has(folderKey(c.folderPath)) : false);
	return {
		...buckets,
		agentModeOtherChats: [],
		archived: buckets.archived.filter(inProject),
		pinned: buckets.pinned.filter(inProject),
		projectList: [project],
		rest: buckets.rest.filter(inProject),
	};
}
