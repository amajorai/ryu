// apps/desktop/src/hooks/useFolderProjectMigration.ts
//
// Moves the desktop's folder-based projects onto the active node's Projects app
// and keeps their threads attached (see `lib/folder-project-migration.ts` for
// the plan). Runs quietly in the background:
//
//   - when the folder projects or the active node change, it creates (or
//     adopts) a node project for each unmapped folder project and re-keys that
//     folder's Project memory to the project id;
//   - whenever the thread list changes, it places threads working in a mapped
//     folder into their project, so chats started from the folder picker after
//     the move land in the project too.
//
// If the node has no Projects app (or is unreachable) nothing happens and the
// next change retries. Nothing here blocks the UI or surfaces an error: the
// folder projects keep working exactly as before until the move succeeds.

import { useEffect, useRef, useState } from "react";
import { useOptionalChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	createProject,
	ensureProjectMainThread,
	fetchProjects,
	rekeyProjectMemory,
	setThreadProject,
} from "@/src/lib/api/hierarchy.ts";
import {
	type FolderProjectMap,
	folderProjectMapKey,
	parseFolderProjectMap,
	planFolderProjectMigration,
	threadsToPlace,
} from "@/src/lib/folder-project-migration.ts";
import { useNodeStore } from "@/src/store/useNodeStore.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";

/** Most thread placements written per pass, so a large history moves gradually. */
const MAX_PLACEMENTS_PER_PASS = 50;

function readMap(key: string): FolderProjectMap {
	try {
		return parseFolderProjectMap(localStorage.getItem(key));
	} catch {
		return {};
	}
}

function writeMap(key: string, map: FolderProjectMap): void {
	try {
		localStorage.setItem(key, JSON.stringify(map));
	} catch {
		// Without storage the move re-plans next time and adopts the projects it
		// already created (matched by folder), so nothing is duplicated.
	}
}

function activeTarget() {
	return toTarget(useNodeStore.getState().getActiveNode());
}

export function useFolderProjectMigration(): void {
	const nodeUrl = useNodeStore((s) => s.getActiveNode().url);
	const mapKey = folderProjectMapKey(nodeUrl);
	const workspaceProjects = useWorkspaceStore((s) => s.projects);
	const projectNames = useWorkspaceStore((s) => s.projectNames);
	const projectIcons = useWorkspaceStore((s) => s.projectIcons);
	const removedProjects = useWorkspaceStore((s) => s.removedProjects);
	const history = useOptionalChatHistoryContext();
	const conversations = history?.conversations;
	const refreshHistory = history?.refresh;
	const [map, setMap] = useState<FolderProjectMap>(() => readMap(mapKey));

	// Switching nodes switches mappings: never place a thread with another
	// node's project ids.
	useEffect(() => {
		setMap(readMap(mapKey));
	}, [mapKey]);
	const migrating = useRef(false);
	// Set when the inputs changed while a run was in flight: that run is
	// cancelled, so its `finally` bumps `migrationTick` to run again on the
	// latest inputs instead of dropping the change.
	const rerunRequested = useRef(false);
	const [migrationTick, setMigrationTick] = useState(0);
	const placing = useRef(new Set<string>());

	// Create or adopt node projects for unmapped folder projects.
	useEffect(() => {
		if (workspaceProjects.length === 0) {
			return;
		}
		if (migrating.current) {
			rerunRequested.current = true;
			return;
		}
		const target = activeTarget();
		let cancelled = false;
		migrating.current = true;
		(async () => {
			const nodeProjects = await fetchProjects(target);
			const next = readMap(mapKey);
			const steps = planFolderProjectMigration({
				map: next,
				nodeProjects,
				projectNames,
				removedFolders: removedProjects,
				workspaceProjects,
			});
			let changed = false;
			for (const step of steps) {
				if (cancelled) {
					break;
				}
				const projectId =
					step.kind === "adopt"
						? step.projectId
						: (
								await createProject(target, {
									coordinatorAgent: "ryu",
									cwd: step.primaryFolder,
									icon: projectIcons[step.primaryFolder] ?? null,
									name: step.name,
								})
							).id;
				next[step.workspaceProject.id] = projectId;
				writeMap(mapKey, next);
				changed = true;
				// Its threads are filed under the project's main thread.
				await ensureProjectMainThread(target, projectId).catch(() => undefined);
				// Bots keep what they learned about these folders.
				for (const folder of step.workspaceProject.folders) {
					await rekeyProjectMemory(target, folder, projectId).catch(
						() => undefined
					);
				}
			}
			if (!cancelled) {
				setMap(changed ? { ...next } : next);
				if (changed) {
					refreshHistory?.();
				}
			}
		})()
			.catch(() => undefined)
			.finally(() => {
				migrating.current = false;
				if (rerunRequested.current) {
					rerunRequested.current = false;
					setMigrationTick((tick) => tick + 1);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		mapKey,
		migrationTick,
		projectIcons,
		projectNames,
		refreshHistory,
		removedProjects,
		workspaceProjects,
	]);

	// Keep threads in mapped folders attached to their project.
	useEffect(() => {
		if (!conversations || workspaceProjects.length === 0) {
			return;
		}
		if (Object.keys(map).length === 0) {
			return;
		}
		const placements = threadsToPlace(conversations, map, workspaceProjects)
			.filter(({ conversationId }) => !placing.current.has(conversationId))
			.slice(0, MAX_PLACEMENTS_PER_PASS);
		if (placements.length === 0) {
			return;
		}
		const target = activeTarget();
		for (const { conversationId } of placements) {
			placing.current.add(conversationId);
		}
		void Promise.allSettled(
			placements.map(({ conversationId, mainThreadId, projectId }) =>
				setThreadProject(target, conversationId, projectId, mainThreadId)
			)
		).then((results) => {
			// A failed placement is retried on the next pass.
			for (const [index, result] of results.entries()) {
				const placement = placements[index];
				if (result.status === "rejected" && placement) {
					placing.current.delete(placement.conversationId);
				}
			}
			if (results.some((result) => result.status === "fulfilled")) {
				refreshHistory?.();
			}
		});
	}, [conversations, map, refreshHistory, workspaceProjects]);
}
