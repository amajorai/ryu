import type { LiteralMessage } from "@ryu/i18n/react";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { FolderClosed, House, Users } from "lucide-react";
import type { ReactNode } from "react";
import { agentById } from "./interface-renderer.ts";
import {
	groupNodeId,
	notebookPageTitle,
	notebookPlacement,
	sectionNodeId,
} from "./notebook-model.ts";
import type { NotebookCrumb, NotebookPageContext } from "./notebook-page.tsx";
import { NotebookAgentArt, NotebookPageGlyph } from "./notebook-parts.tsx";

const ICON = "size-4 shrink-0 text-muted-foreground";

export interface NotebookStartInput {
	agentId?: string;
	projectId?: string;
	teamId?: string;
}

/**
 * The open page's context (agents, project, team) and the top bar's
 * breadcrumbs, from the thread or from how a new page was started.
 * User-named crumbs (groups, page titles) are marked `userData`.
 */
export function notebookPageFrame({
	draft,
	pageOpen,
	reveal,
	snapshot,
	thread,
	tl,
}: {
	draft: NotebookStartInput;
	pageOpen: boolean;
	reveal: (ids: string[]) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | null;
	tl: LiteralMessage;
}): { context: NotebookPageContext; crumbs: NotebookCrumb[] } {
	// The page's place in the tree: from the thread, or from how a new page
	// was started (its project, team, or agent).
	const placementSource = thread ?? {
		agentIds: draft.agentId ? [draft.agentId] : [],
		projectId: draft.projectId ?? null,
		teamId: draft.teamId ?? null,
	};
	const placement = notebookPlacement(snapshot, placementSource);
	const context: NotebookPageContext = {
		agents: placementSource.agentIds
			.map((id) => agentById(snapshot, id))
			.filter((agent) => agent !== undefined),
		project:
			snapshot.groups.find(
				(group) =>
					group.kind === "project" && group.id === placementSource.projectId
			)?.name ?? null,
		team:
			snapshot.groups.find(
				(group) => group.kind === "team" && group.id === placementSource.teamId
			)?.name ?? null,
	};
	if (!thread && context.agents.length === 0 && placement.group) {
		const members =
			snapshot.groups.find((group) => group.id === placement.group?.id)
				?.memberAgentIds ?? [];
		context.agents = members
			.map((id) => agentById(snapshot, id))
			.filter((agent) => agent !== undefined);
	}

	let crumbs: NotebookCrumb[];
	if (pageOpen) {
		// Notion's crumbs start at the top-level page: the sidebar section is a
		// heading, not a page, so it is not a crumb.
		const sectionId = sectionNodeId(placement.section);
		crumbs = [];
		const group = placement.group;
		if (group) {
			const groupId = groupNodeId(group.kind, group.id);
			let icon: ReactNode;
			if (group.kind === "agent") {
				icon = (
					<NotebookAgentArt
						agent={agentById(snapshot, group.id)}
						className="size-4"
						shape="tile"
					/>
				);
			} else if (group.kind === "team") {
				icon = <Users aria-hidden="true" className={ICON} />;
			} else {
				icon = <FolderClosed aria-hidden="true" className={ICON} />;
			}
			crumbs.push({
				icon,
				id: groupId,
				label: group.label,
				userData: true,
				onSelect: () => reveal([sectionId, groupId]),
			});
		}
		crumbs.push({
			icon: <NotebookPageGlyph />,
			id: "page",
			label: thread ? notebookPageTitle(thread) : tl("Untitled"),
			userData: thread !== null,
		});
	} else {
		crumbs = [
			{
				icon: <House aria-hidden="true" className={ICON} />,
				id: "home",
				label: tl("Home"),
			},
		];
	}
	return { context, crumbs };
}
