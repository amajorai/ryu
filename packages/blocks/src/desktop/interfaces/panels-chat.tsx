import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronDown, SquarePen, X } from "lucide-react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot, BoardStatusLabel } from "./board-status.tsx";
import { InterfaceComposer } from "./interface-composer.tsx";
import { compactAge } from "./interface-renderer.ts";
import {
	recentThreads,
	threadAgents,
	threadCounterpart,
} from "./panels-model.ts";

const SWITCHER_LIMIT = 8;

function Switcher({
	now,
	onNewChat,
	onOpenThread,
	snapshot,
	thread,
}: {
	now: number;
	onNewChat: () => void;
	onOpenThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
}) {
	const tl = useLiteralMessages();
	const lead = thread ? threadAgents(snapshot, thread)[0] : undefined;
	const title = thread?.title ?? "New chat";
	const recent = recentThreads(snapshot, SWITCHER_LIMIT);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={tl("Conversation: {title}. Switch conversation", { title })}
				className="flex h-9 min-w-0 max-w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted"
			>
				{lead ? <BoardAvatar agent={lead} name={lead.name} size={20} /> : null}
				<span className="truncate font-medium text-foreground text-sm">
					{title}
				</span>
				<ChevronDown
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="w-80"
				drawerLabel="Switch conversation"
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>Recent</DropdownMenuLabel>
					{recent.map((item) => (
						<DropdownMenuItem
							key={item.id}
							onClick={() => onOpenThread(item.id)}
							selected={item.id === thread?.id}
						>
							<BoardStatusDot status={threadStatus(item)} />
							<span className="min-w-0 flex-1 truncate">{item.title}</span>
							<span className="text-muted-foreground text-xs tabular-nums">
								{compactAge(item.updatedAt, now)}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem onClick={onNewChat}>
					<SquarePen aria-hidden="true" />
					New chat
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * Chat: one persistent conversation, the host's own surface, large and
 * centred under a slim bar with a switcher for recent conversations.
 */
export function PanelsChatOpen({
	now,
	onClose,
	onNewChat,
	onOpenThread,
	snapshot,
	thread,
	threadView,
}: {
	now: number;
	onClose: () => void;
	onNewChat: () => void;
	onOpenThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-label={tl("Conversation: {title}", {
				title: thread?.title ?? "New chat",
			})}
			className="flex size-full min-h-0 flex-col"
			data-testid="panels-chat"
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b @2xl:px-5 px-3">
				<div className="flex min-w-0 flex-1 items-center">
					<Switcher
						now={now}
						onNewChat={onNewChat}
						onOpenThread={onOpenThread}
						snapshot={snapshot}
						thread={thread}
					/>
				</div>
				{thread ? (
					<span className="@lg:inline-flex hidden">
						<BoardStatusLabel status={threadStatus(thread)} />
					</span>
				) : null}
				<Button
					aria-keyshortcuts="Escape"
					aria-label="Close conversation"
					onClick={onClose}
					size="icon-sm"
					title="Close (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="flex min-h-0 flex-1 justify-center">
				<div
					className="flex size-full min-h-0 max-w-[52rem] flex-col"
					data-testid="panels-thread-frame"
				>
					{threadView}
				</div>
			</div>
		</section>
	);
}

/** Chat with nothing open: write to an agent, or pick a recent conversation. */
export function PanelsChatEmpty({
	now,
	onOpenThread,
	onStart,
	snapshot,
}: {
	now: number;
	onOpenThread: (threadId: string) => void;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	snapshot: InterfaceSnapshot;
}) {
	const recent = recentThreads(snapshot, 6);
	return (
		<div
			className="mx-auto flex w-full max-w-[44rem] flex-col gap-10 @2xl:px-8 px-4 @2xl:pt-24 pt-12 pb-16"
			data-testid="panels-chat-empty"
		>
			<h1 className="sr-only">Chat</h1>
			{snapshot.agents.length === 0 ? (
				<p className="text-muted-foreground text-sm">
					Add an agent in Ryu to start a conversation.
				</p>
			) : null}
			{snapshot.agents.length > 0 ? (
				<InterfaceComposer
					agents={snapshot.agents}
					label="Message an agent"
					onSubmit={onStart}
					placeholder="Ask anything"
				/>
			) : null}
			{recent.length > 0 ? (
				<section
					aria-labelledby="panels-chat-recent"
					className="flex flex-col gap-2"
				>
					<h2
						className="font-medium text-muted-foreground text-xs"
						id="panels-chat-recent"
					>
						Recent
					</h2>
					<ul className="flex flex-col divide-y divide-border border-border border-t">
						{recent.map((thread) => {
							const who = threadCounterpart(snapshot, thread);
							const status = threadStatus(thread);
							return (
								<li key={thread.id}>
									<button
										className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-md px-2 py-2.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
										onClick={() => onOpenThread(thread.id)}
										type="button"
									>
										<span className="flex w-2 shrink-0 justify-center">
											<BoardStatusDot status={status} />
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate font-medium text-foreground text-sm">
												{thread.title}
											</span>
											<span className="truncate text-muted-foreground text-xs">
												{[who, THREAD_STATUS_LABELS[status]]
													.filter(Boolean)
													.join(" · ")}
											</span>
										</span>
										<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
											{compactAge(thread.updatedAt, now)}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
		</div>
	);
}
