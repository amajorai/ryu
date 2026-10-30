import type { useChatHistoryContext } from "@/src/contexts/ChatHistoryContext.tsx";
import type { useAgents } from "@/src/hooks/useAgents.ts";
import { conversationsForOtherChats } from "@/src/lib/agent-conversation-groups.ts";
import { dedupeFolders, folderKey } from "@/src/lib/folder-path.ts";
import { workspaceProjectName } from "@/src/lib/workspace-projects.ts";
import type { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { Conversation } from "@/types/chat.ts";
import {
	groupByProject,
	type ProjectBucket,
} from "./sidebar-conversation-list.tsx";
import type { SidebarModeDescriptor } from "./sidebar-modes.ts";
import { projectName } from "./sidebar-panel-state.tsx";

type WorkspaceState = ReturnType<typeof useWorkspaceStore.getState>;

/** Bucket the conversation list into the sidebar's archived, pinned, project
 *  and loose groups. */
export function buildSidebarProjects({
	activeMode,
	agents,
	archivedIds,
	listConversations,
	pinnedIds,
	projectNames,
	recentFolders,
	removedProjects,
	workspaceFolder,
	workspaceProjects,
}: {
	activeMode: SidebarModeDescriptor;
	agents: ReturnType<typeof useAgents>["agents"];
	archivedIds: ReadonlySet<string>;
	listConversations: ReturnType<
		typeof useChatHistoryContext
	>["listConversations"];
	pinnedIds: ReadonlySet<string>;
	projectNames: WorkspaceState["projectNames"];
	recentFolders: WorkspaceState["recentFolders"];
	removedProjects: WorkspaceState["removedProjects"];
	workspaceFolder: WorkspaceState["folder"];
	workspaceProjects: WorkspaceState["projects"];
}) {
	// Archived chats drop into a collapsed bucket (still reachable, so they can be
	// unarchived); pinned chats float to a dedicated section above Chats. The
	// remaining (non-pinned, non-archived) chats group by their workspace folder
	// (loose chats keep no folder), feeding the single nested Projects section.
	const allConversations = listConversations();
	const archived = allConversations.filter((c) => archivedIds.has(c.id));
	const visible = allConversations.filter((c) => !archivedIds.has(c.id));
	const pinned = visible.filter((c) => pinnedIds.has(c.id));
	const rest = visible.filter((c) => !pinnedIds.has(c.id));
	const { projects, loose } = groupByProject(rest, workspaceProjects);

	// The project list shown in the sidebar is the synced union of the composer's
	// recent folders and the folders of existing conversations (durable Core data),
	// minus any folders the user removed from the app. Folders with no chats still
	// appear (rendering a "No chats" hint). Chats whose folder was removed fall back
	// into the loose Chats section so no conversation is hidden.
	// Every one of these three sources spells the same directory its own way, so
	// the union, the removed-set and the bucket lookup all compare by `folderKey`.
	// Keyed on the raw string, `~/x` and `~/x/` were two folders with one name.
	const bucketByPath = new Map(projects.map((p) => [folderKey(p.path), p]));
	const removedSet = new Set(removedProjects.map(folderKey));
	const workspaceProjectByFolder = new Map(
		workspaceProjects.flatMap((project) =>
			project.folders.map((path) => [folderKey(path), project] as const)
		)
	);
	const projectPaths = dedupeFolders(
		[
			...(workspaceFolder ? [workspaceFolder] : []),
			...recentFolders,
			...projects.map((p) => p.path),
		].map(
			(path) =>
				workspaceProjectByFolder.get(folderKey(path))?.folders[0] ?? path
		)
	).filter((path) => !removedSet.has(folderKey(path)));
	const projectList: ProjectBucket[] = projectPaths.map((path) => {
		const existing = bucketByPath.get(folderKey(path));
		const workspaceProject = workspaceProjectByFolder.get(folderKey(path));
		const name = workspaceProject
			? workspaceProjectName(workspaceProject, projectNames)
			: projectName(path, projectNames);
		if (existing) {
			return existing.name === name ? existing : { ...existing, name };
		}
		return {
			conversations: [],
			name,
			path,
			sourceFolders: workspaceProject?.folders ?? [path],
		};
	});
	const looseChats: Conversation[] = [
		...loose,
		...projects
			.filter((p) => removedSet.has(folderKey(p.path)))
			.flatMap((p) => p.conversations),
	];
	const knownAgentIds = new Set(agents.map((agent) => agent.id));
	// Direct conversations are already rendered under their bot in the focused
	// Agents view. Keep group chats and rows whose agent is missing from the
	// roster in the fallback list so removing the old tab never hides a thread.
	const agentModeOtherChats =
		activeMode.key === "agent"
			? conversationsForOtherChats(rest, knownAgentIds)
			: looseChats;
	return {
		agentModeOtherChats,
		allConversations,
		archived,
		pinned,
		projectList,
		rest,
	};
}
