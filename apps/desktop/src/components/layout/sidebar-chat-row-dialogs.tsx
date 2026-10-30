// What a sidebar chat row mounts below itself: the expanded Messages and Side
// chats sub-accordions, the node handoff dialog, delete confirmation, linked
// pull requests and the icon picker.

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { Dispatch, SetStateAction } from "react";
import { ContinueOnNodeDialog } from "@/src/components/chat/ContinueOnNodeDialog.tsx";
import type { useTabsContext } from "@/src/contexts/TabsContext.tsx";
import type { Node } from "@/src/store/useNodeStore.ts";
import type { Conversation } from "@/types/chat.ts";
import { EntityIconDialog } from "./EntityIconDialog.tsx";
import { LinkedPullRequestsDialog } from "./LinkedPullRequestsDialog.tsx";
import {
	ChatRowSubAccordion,
	SidebarChatMessages,
} from "./sidebar-chat-messages.tsx";
import type { ChatRowHandlers } from "./sidebar-chat-row-types.ts";
import { SidebarSideChats } from "./sidebar-side-chats.tsx";

export function ChatRowDialogs({
	confirmDeleteOpen,
	conv,
	handlers,
	handoff,
	iconDialogOpen,
	linkedPullRequests,
	messagesExpanded,
	openTab,
	pullRequestsDialogOpen,
	resolveConfiguredNodes,
	rowExpanded,
	setConfirmDeleteOpen,
	setConversationPullRequestLinked,
	setHandoff,
	setIconDialogOpen,
	setMessagesExpanded,
	setPullRequestsDialogOpen,
	setSideChatsExpanded,
	sideChatsExpanded,
}: {
	confirmDeleteOpen: boolean;
	conv: Conversation;
	handlers: ChatRowHandlers;
	handoff: { nodes: Node[]; sourceNode: Node } | null;
	iconDialogOpen: boolean;
	linkedPullRequests: string[];
	messagesExpanded: boolean;
	openTab: ReturnType<typeof useTabsContext>["openTab"];
	pullRequestsDialogOpen: boolean;
	resolveConfiguredNodes: () => Node[];
	rowExpanded: boolean;
	setConfirmDeleteOpen: (open: boolean) => void;
	setConversationPullRequestLinked:
		| ((id: string, url: string, linked: boolean) => Promise<void>)
		| undefined;
	setHandoff: (handoff: { nodes: Node[]; sourceNode: Node } | null) => void;
	setIconDialogOpen: (open: boolean) => void;
	setMessagesExpanded: Dispatch<SetStateAction<boolean>>;
	setPullRequestsDialogOpen: (open: boolean) => void;
	setSideChatsExpanded: Dispatch<SetStateAction<boolean>>;
	sideChatsExpanded: boolean;
}) {
	const tl = useLiteralMessages();
	const {
		loadMessages,
		onDeleteConversation,
		onJumpToMessage,
		onOpenSideChat,
		onSetConversationIcon,
		pullRequestsEnabled = false,
		sideChatsEnabled = true,
		target,
	} = handlers;
	return (
		<>
			{rowExpanded && (
				<div className="flex flex-col gap-0.5 pb-1">
					<ChatRowSubAccordion
						expanded={messagesExpanded}
						label="Messages"
						onToggle={() => setMessagesExpanded((v) => !v)}
					>
						<SidebarChatMessages
							agentId={conv.agentId}
							conversationId={conv.id}
							loadMessages={loadMessages}
							onJump={(messageId) => onJumpToMessage(conv.id, messageId)}
						/>
					</ChatRowSubAccordion>
					{sideChatsEnabled && (
						<ChatRowSubAccordion
							expanded={sideChatsExpanded}
							label="Side chats"
							onToggle={() => setSideChatsExpanded((v) => !v)}
						>
							<SidebarSideChats
								conversationId={conv.id}
								onOpen={(entry) => onOpenSideChat(conv.id, entry)}
								target={target}
							/>
						</ChatRowSubAccordion>
					)}
				</div>
			)}
			{handoff ? (
				<ContinueOnNodeDialog
					conversationId={conv.id}
					conversationTitle={conv.title}
					nodes={handoff.nodes}
					onCompleted={async (destination, _result, workspaceResult) => {
						// A resumed working tree is a handed-off worktree; Core refuses
						// to fork a managed worktree from it, so this tab runs Local.
						openTab("/chat", {
							conversationId: conv.id,
							node: destination.name,
							worktreeMode: workspaceResult ? false : undefined,
						});
						toast.success(
							tl("Continued on {name}", { name: destination.name })
						);
					}}
					onOpenChange={(open) => {
						if (!open) {
							setHandoff(null);
						}
					}}
					open
					resolveNodes={resolveConfiguredNodes}
					sourceNode={handoff.sourceNode}
					sourceUpdatedAt={conv.updatedAt}
				/>
			) : null}
			<AlertDialog onOpenChange={setConfirmDeleteOpen} open={confirmDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete this chat?</AlertDialogTitle>
						<AlertDialogDescription>
							{tl(
								'"{title}" will be permanently deleted. This cannot be undone.',
								{ title: conv.title }
							)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => onDeleteConversation(conv.id)}
							variant="destructive"
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
			{pullRequestsEnabled && setConversationPullRequestLinked ? (
				<LinkedPullRequestsDialog
					linkedPullRequests={linkedPullRequests}
					onOpenChange={setPullRequestsDialogOpen}
					onSetLinked={(url, linked) =>
						setConversationPullRequestLinked(conv.id, url, linked)
					}
					open={pullRequestsDialogOpen}
					target={target}
					title={conv.title}
				/>
			) : null}
			<EntityIconDialog
				description={conv.title}
				onChange={(icon) => onSetConversationIcon(conv.id, icon)}
				onOpenChange={setIconDialogOpen}
				open={iconDialogOpen}
				title="Chat icon"
				value={conv.icon ?? null}
			/>
		</>
	);
}
