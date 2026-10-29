import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { z } from "zod";
// apps/desktop/src/lib/folder-project-migration.ts
//
// Turning the desktop's folder-based projects into node projects.
//
// Before the Projects › Bots/Groups › Sessions hierarchy, a "project" was a
// desktop-local list of folders, and Project memory was keyed by the working
// folder path. Projects now live on the node (the Projects app), and threads and
// memory are keyed by the project id. This module plans the one-time move:
//
//   1. each folder project gets a node project (reusing one the node already
//      has for the same primary folder, so two desktops never duplicate it);
//   2. memory keyed by any of its folders is re-keyed to the project id;
//   3. its threads (matched by working folder) are placed in the project —
//      and keep being placed as new chats start in those folders.
//
// The folder → project mapping is device-local (folders are machine facts) and
// per node (each node has its own projects). Everything here is pure; the
// `useFolderProjectMigration` hook performs the requests.

import type { ProjectRecord } from "@/src/lib/api/hierarchy.ts";
import { folderKey, sameFolder } from "@/src/lib/folder-path.ts";
import { isProjectMainThread } from "@/src/lib/thread-hierarchy.ts";
import {
	primaryProjectFolder,
	type WorkspaceProject,
	workspaceProjectName,
} from "@/src/lib/workspace-projects.ts";
import type { Conversation } from "@/types/chat.ts";

/** Storage key prefix for the per-node `workspaceProjectId -> projectId` map. */
export const FOLDER_PROJECT_MAP_KEY = "ryu:folder-project-map:v1";

export type FolderProjectMap = Record<string, string>;

/** The storage key for one node's mapping. */
export function folderProjectMapKey(nodeUrl: string): string {
	return `${FOLDER_PROJECT_MAP_KEY}:${nodeUrl.trim().replace(/\/+$/, "")}`;
}

/** Parse a stored mapping, dropping anything malformed. */
export function parseFolderProjectMap(raw: string | null): FolderProjectMap {
	if (!raw) {
		return {};
	}
	try {
		const parsed = z.record(z.string(), z.unknown()).safeParse(JSON.parse(raw));
		if (!parsed.success) {
			return {};
		}
		const map = new Map<string, string>();
		for (const [key, projectId] of Object.entries(parsed.data)) {
			if (key.trim() && isNativeText(projectId) && projectId.trim()) {
				map.set(key, projectId);
			}
		}
		return Object.fromEntries(map);
	} catch {
		return {};
	}
}

/** What to do for one folder project. */
export type MigrationStep =
	| {
			/** An existing node project already covers this folder: adopt it. */
			kind: "adopt";
			projectId: string;
			workspaceProject: WorkspaceProject;
	  }
	| {
			kind: "create";
			name: string;
			primaryFolder: string;
			workspaceProject: WorkspaceProject;
	  };

/**
 * Which folder projects still need a node project. Projects already mapped (to
 * a project the node still has), with no folder, or removed by the user are
 * skipped.
 */
export function planFolderProjectMigration(input: {
	map: FolderProjectMap;
	nodeProjects: readonly ProjectRecord[];
	projectNames?: Readonly<Record<string, string>>;
	removedFolders?: readonly string[];
	workspaceProjects: readonly WorkspaceProject[];
}): MigrationStep[] {
	const known = new Set(input.nodeProjects.map((project) => project.id));
	const removed = new Set((input.removedFolders ?? []).map(folderKey));
	const steps: MigrationStep[] = [];
	for (const workspaceProject of input.workspaceProjects) {
		const mapped = input.map[workspaceProject.id];
		if (mapped && known.has(mapped)) {
			continue;
		}
		const primaryFolder = primaryProjectFolder(workspaceProject);
		if (!primaryFolder || removed.has(folderKey(primaryFolder))) {
			continue;
		}
		const existing = input.nodeProjects.find(
			(project) => project.cwd && sameFolder(project.cwd, primaryFolder)
		);
		if (existing) {
			steps.push({ kind: "adopt", projectId: existing.id, workspaceProject });
			continue;
		}
		steps.push({
			kind: "create",
			name: workspaceProjectName(workspaceProject, input.projectNames),
			primaryFolder,
			workspaceProject,
		});
	}
	return steps;
}

/** The node project a working folder belongs to, via the mapping. */
export function projectForFolder(
	folder: string,
	map: FolderProjectMap,
	workspaceProjects: readonly WorkspaceProject[]
): string | null {
	for (const workspaceProject of workspaceProjects) {
		const projectId = map[workspaceProject.id];
		if (
			projectId &&
			workspaceProject.folders.some((candidate) =>
				sameFolder(candidate, folder)
			)
		) {
			return projectId;
		}
	}
	return null;
}

/**
 * Threads that work in a mapped project's folder but are not in a project yet.
 * A thread already in a project is never moved: an explicit placement wins over
 * the folder it happens to run in.
 */
export function threadsToPlace(
	conversations: readonly Conversation[],
	map: FolderProjectMap,
	workspaceProjects: readonly WorkspaceProject[]
): ThreadPlacement[] {
	const mainThreads = new Map<string, string>();
	for (const conversation of conversations) {
		const ownerId = conversation.hierarchy?.ownerId;
		if (ownerId && isProjectMainThread(conversation)) {
			mainThreads.set(ownerId, conversation.id);
		}
	}
	const placements: ThreadPlacement[] = [];
	for (const conversation of conversations) {
		if (
			conversation.hierarchy?.projectId ||
			conversation.hierarchy?.role === "main" ||
			!conversation.folderPath
		) {
			continue;
		}
		const projectId = projectForFolder(
			conversation.folderPath,
			map,
			workspaceProjects
		);
		// Wait until the project's main thread is loaded: a thread placed in a
		// project with no parent would be a hidden session with nowhere to be
		// reached from.
		const mainThreadId = projectId ? mainThreads.get(projectId) : undefined;
		if (projectId && mainThreadId) {
			placements.push({
				conversationId: conversation.id,
				mainThreadId,
				projectId,
			});
		}
	}
	return placements;
}

/** Where one thread goes: its project, under the project's main thread so it
 * stays reachable from that thread's Sessions panel. */
export interface ThreadPlacement {
	conversationId: string;
	mainThreadId: string;
	projectId: string;
}
