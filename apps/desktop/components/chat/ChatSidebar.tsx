import {
	Add01Icon,
	Delete01Icon,
	MoreVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";

import {
	formatDistanceToNow,
	isThisWeek,
	isToday,
	isYesterday,
} from "date-fns";
import { NodeSelector } from "@/src/components/shell/NodeSelector.tsx";
import { useNodeDisplayMode } from "@/src/hooks/useNodeDisplayMode.ts";
import type { Conversation } from "@/types/chat.ts";

interface ChatSidebarProps {
	activeConversationId: string | null;
	conversations: Conversation[];
	onDeleteConversation: (id: string) => void;
	onNewConversation: () => void;
	onSelectConversation: (id: string) => void;
}

type DateGroup = "Today" | "Yesterday" | "This Week" | "Older";

const GROUP_ORDER: DateGroup[] = ["Today", "Yesterday", "This Week", "Older"];

function groupByDate(convs: Conversation[]): Record<DateGroup, Conversation[]> {
	const groups: Record<DateGroup, Conversation[]> = {
		Today: [],
		Yesterday: [],
		"This Week": [],
		Older: [],
	};
	for (const conv of convs) {
		const d = new Date(conv.updatedAt);
		if (isToday(d)) {
			groups.Today.push(conv);
		} else if (isYesterday(d)) {
			groups.Yesterday.push(conv);
		} else if (isThisWeek(d)) {
			groups["This Week"].push(conv);
		} else {
			groups.Older.push(conv);
		}
	}
	return groups;
}

export function ChatSidebar({
	conversations,
	activeConversationId,
	onSelectConversation,
	onNewConversation,
	onDeleteConversation,
}: ChatSidebarProps) {
	const groups = groupByDate(conversations);
	const nodeDisplayMode = useNodeDisplayMode();

	return (
		<div className="flex h-full flex-col">
			<div className="border-b px-2 pt-3 pb-2">
				<NodeSelector mode={nodeDisplayMode} />
			</div>
			<div className="border-b p-3">
				<Button
					className="w-full"
					onClick={onNewConversation}
					size="sm"
					variant="outline"
				>
					<HugeiconsIcon className="mr-2" icon={Add01Icon} size={14} />
					New chat
				</Button>
			</div>

			<div className="flex-1 overflow-y-auto p-2">
				{conversations.length === 0 ? (
					<p className="py-8 text-center text-muted-foreground text-xs">
						No chats yet
					</p>
				) : (
					GROUP_ORDER.map((groupName) => {
						const convs = groups[groupName];
						if (convs.length === 0) {
							return null;
						}
						return (
							<div className="mb-3" key={groupName}>
								<p className="px-2 py-1 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
									{groupName}
								</p>
								{convs.map((conv) => (
									<div
										className={`group mb-0.5 flex cursor-pointer items-center justify-between rounded-md px-2 py-1.5 transition-colors hover:bg-muted ${
											activeConversationId === conv.id ? "bg-muted" : ""
										}`}
										key={conv.id}
										onClick={() => onSelectConversation(conv.id)}
										onKeyDown={(e) => {
											if (e.key === "Enter") {
												onSelectConversation(conv.id);
											}
										}}
										role="button"
										tabIndex={0}
									>
										<div className="min-w-0 flex-1">
											<p className="truncate text-sm">{conv.title}</p>
											<p className="text-muted-foreground text-xs">
												{formatDistanceToNow(conv.updatedAt, {
													addSuffix: true,
												})}
											</p>
										</div>

										<DropdownMenu>
											<DropdownMenuTrigger
												className="inline-flex h-6 w-6 items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
												onClick={(e) => e.stopPropagation()}
											>
												<HugeiconsIcon icon={MoreVerticalIcon} size={12} />
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end">
												<DropdownMenuItem
													className="text-destructive"
													onClick={(e) => {
														e.stopPropagation();
														onDeleteConversation(conv.id);
													}}
												>
													<HugeiconsIcon
														className="mr-2"
														icon={Delete01Icon}
														size={12}
													/>
													Delete
												</DropdownMenuItem>
											</DropdownMenuContent>
										</DropdownMenu>
									</div>
								))}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
