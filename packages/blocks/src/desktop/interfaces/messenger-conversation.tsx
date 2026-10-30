import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { MessagesSquare, SquarePen } from "lucide-react";
import type { ReactNode } from "react";
import { MessengerAvatar, TypingDots } from "./messenger-avatar.tsx";
import {
	BackButton,
	HeaderBar,
	HeaderTitle,
} from "./messenger-conversation-chrome.tsx";
import { MessengerComposer } from "./messenger-conversation-composer.tsx";
import { ConversationStart } from "./messenger-conversation-start.tsx";
import {
	RunNotice,
	ThreadSwitcher,
} from "./messenger-conversation-threads.tsx";
import {
	canStartWith,
	type MessengerEntry,
	typingLabel,
	typingMembers,
} from "./messenger-model.ts";

export { MessengerCompose } from "./messenger-conversation-compose.tsx";
export { MessengerComposer } from "./messenger-conversation-composer.tsx";

/** Right column for a selected contact (or an open thread with no contact). */
export function MessengerConversation({
	activeThread,
	entry,
	onBack,
	onNewConversation,
	onOpenThread,
	onSend,
	threads,
	threadView,
}: {
	activeThread: InterfaceThread | undefined;
	entry: MessengerEntry | undefined;
	onBack: () => void;
	onNewConversation: (entry: MessengerEntry) => void;
	onOpenThread: (threadId: string) => void;
	onSend: (entry: MessengerEntry, text: string) => void;
	threads: InterfaceThread[];
	threadView: ReactNode | null;
}) {
	const tl = useLiteralMessages();
	if (!entry) {
		return (
			<section
				aria-label={activeThread?.title || "Conversation"}
				className="flex size-full min-h-0 flex-col"
			>
				<HeaderBar>
					<BackButton onBack={onBack} />
					<span
						aria-hidden="true"
						className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
					>
						<MessagesSquare className="size-4" />
					</span>
					<div className="min-w-0 flex-1">
						<HeaderTitle>{activeThread?.title || "Conversation"}</HeaderTitle>
						<p className="truncate text-muted-foreground text-xs">
							No agent assigned
						</p>
					</div>
				</HeaderBar>
				<div className="min-h-0 flex-1">{threadView}</div>
			</section>
		);
	}
	// The open conversation decides presence; with none open, the contact does.
	const shown = threadView && activeThread ? activeThread : undefined;
	const typingNames = shown
		? typingMembers(entry.members, [shown])
		: entry.working;
	const typing = shown ? shown.running : entry.running;
	let subtitle = entry.description;
	if (typing) {
		subtitle =
			entry.kind === "team" ? typingLabel(typingNames) || "typing" : "typing";
	}
	const startable = canStartWith(entry);
	return (
		<section
			aria-label={tl("Conversation with {name}", { name: entry.name })}
			className="flex size-full min-h-0 flex-col"
		>
			<HeaderBar>
				<BackButton onBack={onBack} />
				<MessengerAvatar
					entry={entry}
					ringClassName="ring-background"
					size="header"
				/>
				<div className="min-w-0 flex-1">
					<HeaderTitle>{entry.name}</HeaderTitle>
					<p
						aria-live="polite"
						className="flex items-center gap-1.5 truncate text-muted-foreground text-xs"
					>
						<span className="truncate">{subtitle}</span>
						{typing ? <TypingDots /> : null}
					</p>
				</div>
				{startable ? (
					<Tooltip>
						<TooltipTrigger
							render={
								<Button
									aria-label={tl("New conversation with {name}", {
										name: entry.name,
									})}
									onClick={() => onNewConversation(entry)}
									size="icon-sm"
									variant="ghost"
								/>
							}
						>
							<SquarePen aria-hidden="true" />
						</TooltipTrigger>
						<TooltipContent side="bottom">New conversation</TooltipContent>
					</Tooltip>
				) : null}
			</HeaderBar>
			<ThreadSwitcher
				activeThreadId={activeThread?.id ?? null}
				entry={entry}
				onOpen={onOpenThread}
				threads={threads}
			/>
			{threadView && activeThread ? <RunNotice thread={activeThread} /> : null}
			{threadView ? (
				<div className="min-h-0 flex-1" data-testid="messenger-thread">
					{threadView}
				</div>
			) : (
				<>
					<ConversationStart entry={entry} />
					{startable ? (
						<MessengerComposer
							key={entry.key}
							label={tl("Message {name}", { name: entry.name })}
							onSend={(text) => onSend(entry, text)}
							placeholder={tl("Message {name}", { name: entry.name })}
						/>
					) : null}
				</>
			)}
		</section>
	);
}

/** Nothing selected yet (wide layout only): a near-blank pane. */
export function MessengerWelcome({
	hasContacts,
	loading,
}: {
	hasContacts: boolean;
	loading: boolean;
}) {
	if (loading) {
		return (
			<div aria-busy="true" className="size-full">
				<span className="sr-only" role="status">
					Loading conversations…
				</span>
			</div>
		);
	}
	return (
		<div className="flex size-full flex-col items-center justify-center gap-4 px-6 text-center">
			<span
				aria-hidden="true"
				className="flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground"
			>
				<MessagesSquare className="size-7" />
			</span>
			<div className="flex max-w-sm flex-col gap-1.5">
				<p className="font-semibold text-base">
					{hasContacts
						? "No conversation selected"
						: "Create an agent to start messaging"}
				</p>
				<p className="text-muted-foreground text-sm">
					{hasContacts
						? "Pick a contact on the left, or start a new message."
						: "Agents and teams show up here as contacts you can message."}
				</p>
			</div>
		</div>
	);
}
