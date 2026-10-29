import { useLiteralMessages } from "@ryu/i18n/react";
import type { WorkbenchItem } from "@ryu/workbench/model";
import { useEffect } from "react";
import {
	ConversationPanelContent,
	ProjectDockTabContent,
} from "@/src/components/panels/WorkspacePanels.tsx";
import { usePluginContributions } from "@/src/hooks/usePluginContributions.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import { useConversationPanelSource } from "./conversation-panel-registry.ts";
import { useDesktopWorkbench } from "./DesktopWorkbenchContext.tsx";
import { clearPanelCommand, usePanelCommand } from "./panel-commands.ts";
import {
	isConversationPanelKind,
	scopeMatchesFolder,
	shellPanelKind,
} from "./shell-panels.ts";

function folderName(folder: string): string {
	return (
		folder
			.replace(/[\\/]+$/, "")
			.split(/[\\/]/)
			.at(-1) ?? folder
	);
}

function PanelNotice({ text }: { text: string }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-muted-foreground text-xs">
			{text}
		</div>
	);
}

/**
 * Renders a tool or app panel as a workbench tab through the same renderer the
 * chat docks use (no copied panel bodies). Mounted once by WorkbenchItemHost,
 * so moving the tab between regions keeps a terminal's session alive.
 */
export function ShellWorkbenchItem({ item }: { item: WorkbenchItem }) {
	const tl = useLiteralMessages();
	const { state } = useDesktopWorkbench();
	const folder = useWorkspaceStore((store) => store.folder);
	const { dock_panels: dockPanels } = usePluginContributions();
	const conversationId =
		item.scope.kind === "conversation" ? item.scope.conversationId : null;
	const conversationSource = useConversationPanelSource(conversationId);
	const request = usePanelCommand(item.id);
	// The host unmounts a tab only when it closes; its request goes with it.
	useEffect(() => () => clearPanelCommand(item.id), [item.id]);
	const kind = shellPanelKind(item);
	if (!kind) {
		return null;
	}
	const group = state.groups.find((candidate) =>
		candidate.itemIds.includes(item.id)
	);
	const active =
		group?.activeItemId === item.id &&
		(group.region === "center" || state.openRegions[group.region]);
	if (isConversationPanelKind(kind)) {
		if (!conversationId) {
			return (
				<PanelNotice
					text={tl("Open {title} from its chat to see it here.", {
						title: item.title,
					})}
				/>
			);
		}
		if (!conversationSource) {
			// Never fall back to another chat's data.
			return (
				<PanelNotice text="This chat is closed. Reopen it to see this panel." />
			);
		}
		return (
			<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
				<ConversationPanelContent
					active={active}
					kind={kind}
					label={item.title}
					source={conversationSource}
					uid={item.id}
				/>
			</div>
		);
	}
	if (!scopeMatchesFolder(item.scope, folder)) {
		return (
			<PanelNotice
				text={
					item.scope.kind === "project"
						? tl(
								"{title} belongs to {projectName}. Open that project to use it.",
								{
									projectName: folderName(item.scope.folder),
									title: item.title,
								}
							)
						: tl("{title} isn't available here.", { title: item.title })
				}
			/>
		);
	}
	return (
		<div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			<ProjectDockTabContent
				active={active}
				dockPanels={dockPanels}
				folder={item.scope.kind === "project" ? item.scope.folder : folder}
				request={request}
				tab={{ kind, label: item.title, uid: item.id }}
			/>
		</div>
	);
}
