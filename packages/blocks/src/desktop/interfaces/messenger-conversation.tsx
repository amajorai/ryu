import { Button } from "@ryu/ui/components/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@ryu/ui/components/input-group.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	ArrowUp,
	ChevronDown,
	ChevronLeft,
	CircleAlert,
	MessagesSquare,
	SquarePen,
	Users,
	X,
} from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { compactAge } from "./interface-renderer.ts";
import { MessengerAvatar, TypingDots } from "./messenger-avatar.tsx";
import {
	canStartWith,
	fullTimestamp,
	type MessengerEntry,
	matchRecipients,
	typingLabel,
	typingMembers,
} from "./messenger-model.ts";

const LIST_STEP: Record<string, number> = {
	ArrowDown: 1,
	ArrowUp: -1,
};

/** Pills shown inline before the rest move into a "More" menu. */
const MAX_PILLS = 3;

const STATUS_DOT: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "border border-muted-foreground",
	waiting: "bg-muted-foreground",
	working: "bg-success motion-safe:animate-pulse",
	"your-turn": "bg-primary",
};

/** Back to the contact list; only shown at narrow widths. */
function BackButton({ onBack }: { onBack: () => void }) {
	return (
		<Button
			aria-label="Back to messages"
			className="-ml-1 @min-[900px]:hidden text-primary hover:text-primary"
			onClick={onBack}
			size="icon-sm"
			variant="ghost"
		>
			<ChevronLeft aria-hidden="true" className="size-5" />
		</Button>
	);
}

function HeaderBar({ children }: { children: ReactNode }) {
	return (
		<header className="flex h-16 shrink-0 items-center gap-3 border-border border-b bg-background/95 px-5 backdrop-blur">
			{children}
		</header>
	);
}

/**
 * The header's name. App UI pins headings to the heading face at weight 500,
 * so the visible text is a sans span at the list's semibold weight.
 */
function HeaderTitle({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<h2 className={cn("truncate leading-5", className)}>
			<span className="font-sans font-semibold text-[15px]">{children}</span>
		</h2>
	);
}

/**
 * A message box: Enter sends, Shift+Enter adds a line. Only text the user
 * typed and submitted here is ever passed to `onSend`.
 */
export function MessengerComposer({
	disabledReason,
	inputRef,
	label,
	onSend,
	placeholder,
}: {
	/** When set, sending is blocked and this explains why. */
	disabledReason?: string;
	inputRef?: RefObject<HTMLTextAreaElement | null>;
	label: string;
	onSend: (text: string) => void;
	placeholder: string;
}) {
	const [draft, setDraft] = useState("");
	const hintId = useId();
	const text = draft.trim();
	const canSend = text.length > 0 && !disabledReason;
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (!canSend) {
			return;
		}
		onSend(text);
		setDraft("");
	};
	return (
		<form
			aria-label={label}
			className="shrink-0 border-border border-t bg-background px-4 py-3"
			onSubmit={submit}
		>
			<InputGroup className="rounded-3xl border-border bg-background has-[textarea]:rounded-3xl">
				<InputGroupTextarea
					aria-describedby={disabledReason ? hintId : undefined}
					aria-label={placeholder}
					className="max-h-40 min-h-10 py-2.5 pl-4 text-sm"
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							submit();
						}
					}}
					placeholder={placeholder}
					ref={inputRef}
					rows={1}
					value={draft}
				/>
				<InputGroupAddon align="inline-end" className="self-end pb-1.5">
					<InputGroupButton
						aria-label="Send"
						className="rounded-full bg-primary text-primary-foreground hover:bg-primary/85 hover:text-primary-foreground disabled:bg-muted disabled:text-muted-foreground"
						disabled={!canSend}
						size="icon-sm"
						type="submit"
						variant="default"
					>
						<ArrowUp aria-hidden="true" />
					</InputGroupButton>
				</InputGroupAddon>
			</InputGroup>
			{disabledReason ? (
				<p className="mt-1.5 px-4 text-muted-foreground text-xs" id={hintId}>
					{disabledReason}
				</p>
			) : null}
		</form>
	);
}

function threadLabel(thread: InterfaceThread, isGroup: boolean): string {
	const status = THREAD_STATUS_LABELS[threadStatus(thread)];
	const prefix = isGroup ? "Group conversation, " : "";
	const age = compactAge(thread.updatedAt);
	let updated = "";
	if (age === "now") {
		updated = ", updated just now";
	} else if (age) {
		updated = `, updated ${age} ago`;
	}
	return `${prefix}${thread.title || "Untitled"}, ${status}${updated}`;
}

function isGroupThread(entry: MessengerEntry, thread: InterfaceThread) {
	return entry.kind === "agent" && thread.agentIds.length > 1;
}

function ThreadPill({
	active,
	entry,
	onOpen,
	thread,
}: {
	active: boolean;
	entry: MessengerEntry;
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	const isGroup = isGroupThread(entry, thread);
	return (
		<li className="min-w-0 max-w-80">
			<button
				aria-current={active ? "true" : undefined}
				aria-label={threadLabel(thread, isGroup)}
				className={cn(
					"flex h-7 max-w-full items-center gap-2 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
					active
						? "bg-muted font-medium text-foreground"
						: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
				)}
				onClick={() => onOpen(thread.id)}
				title={`${thread.title || "Untitled"} · ${THREAD_STATUS_LABELS[status]} · ${fullTimestamp(thread.updatedAt)}`}
				type="button"
			>
				<span
					aria-hidden="true"
					className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[status])}
				/>
				{isGroup ? (
					<Users aria-hidden="true" className="size-3.5 shrink-0" />
				) : null}
				<span className="truncate">{thread.title || "Untitled"}</span>
				<span
					aria-hidden="true"
					className="shrink-0 font-normal text-muted-foreground tabular-nums"
				>
					{compactAge(thread.updatedAt)}
				</span>
			</button>
		</li>
	);
}

/** Older conversations past {@link MAX_PILLS}, in a menu. */
function MoreThreads({
	entry,
	onOpen,
	threads,
}: {
	entry: MessengerEntry;
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	return (
		<li>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={`${threads.length} more conversations with ${entry.name}`}
					className="flex h-7 items-center gap-1 rounded-md px-2.5 text-muted-foreground text-xs outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
				>
					<span className="flex items-center gap-1 whitespace-nowrap">
						{`More (${threads.length})`}
						<ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
					</span>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="max-h-80 w-80"
					drawerLabel={`Conversations with ${entry.name}`}
				>
					{threads.map((thread) => {
						const status = threadStatus(thread);
						return (
							<DropdownMenuItem
								aria-label={threadLabel(thread, isGroupThread(entry, thread))}
								className="gap-2"
								key={thread.id}
								onClick={() => onOpen(thread.id)}
							>
								<span
									aria-hidden="true"
									className={cn(
										"size-2 shrink-0 rounded-full",
										STATUS_DOT[status]
									)}
								/>
								<span className="min-w-0 flex-1 truncate">
									{thread.title || "Untitled"}
								</span>
								<span
									aria-hidden="true"
									className="shrink-0 text-muted-foreground text-xs tabular-nums"
								>
									{compactAge(thread.updatedAt)}
								</span>
							</DropdownMenuItem>
						);
					})}
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	);
}

/**
 * The contact's conversations as wrapping pills, newest first. Past
 * {@link MAX_PILLS} the rest sit in a "More" menu; the open one always
 * keeps its pill.
 */
function ThreadSwitcher({
	activeThreadId,
	entry,
	onOpen,
	threads,
}: {
	activeThreadId: string | null;
	entry: MessengerEntry;
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const [only] = threads;
	// One conversation that is already open: the chat itself names it.
	if (!only || (threads.length === 1 && only.id === activeThreadId)) {
		return null;
	}
	let inline = threads;
	let overflow: InterfaceThread[] = [];
	if (threads.length > MAX_PILLS + 1) {
		inline = threads.slice(0, MAX_PILLS);
		overflow = threads.slice(MAX_PILLS);
		const active = overflow.find((thread) => thread.id === activeThreadId);
		if (active) {
			inline = [...threads.slice(0, MAX_PILLS - 1), active];
			overflow = threads.filter((thread) => !inline.includes(thread));
		}
	}
	return (
		<nav
			aria-label={`Conversations with ${entry.name}`}
			className="shrink-0 border-border border-b bg-background"
		>
			<ul className="flex flex-wrap items-center gap-1 px-3 py-2">
				{inline.map((thread) => (
					<ThreadPill
						active={thread.id === activeThreadId}
						entry={entry}
						key={thread.id}
						onOpen={onOpen}
						thread={thread}
					/>
				))}
				{overflow.length > 0 ? (
					<MoreThreads entry={entry} onOpen={onOpen} threads={overflow} />
				) : null}
			</ul>
		</nav>
	);
}

/** A slim notice when the open thread's last run failed or was interrupted. */
function RunNotice({ thread }: { thread: InterfaceThread }) {
	if (threadStatus(thread) !== "attention") {
		return null;
	}
	return (
		<p
			className="flex h-8 shrink-0 items-center gap-2 border-border border-b px-4 text-destructive text-xs"
			role="status"
		>
			<CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
			{thread.runState === "interrupted"
				? "The last run was interrupted."
				: "The last run failed."}
		</p>
	);
}

function startText(entry: MessengerEntry, hasHistory: boolean): string {
	if (!canStartWith(entry)) {
		return "Pick a conversation above to read it and reply.";
	}
	return hasHistory
		? "Pick an earlier conversation above, or send a message to start a new one."
		: `This is the start of your conversation with ${entry.name}.`;
}

/** Opening state for a contact with no conversation open. */
function ConversationStart({ entry }: { entry: MessengerEntry }) {
	const hasHistory = entry.threadIds.length > 0;
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-y-auto px-6 py-10 text-center">
			<MessengerAvatar
				entry={entry}
				ringClassName="ring-background"
				size="header"
			/>
			<div className="flex flex-col gap-1">
				<p className="font-medium text-sm">{entry.name}</p>
				{entry.description ? (
					<p className="max-w-sm text-muted-foreground text-sm">
						{entry.description}
					</p>
				) : null}
			</div>
			<p className="max-w-sm text-muted-foreground text-xs">
				{startText(entry, hasHistory)}
			</p>
		</div>
	);
}

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
			aria-label={`Conversation with ${entry.name}`}
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
									aria-label={`New conversation with ${entry.name}`}
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
							label={`Message ${entry.name}`}
							onSend={(text) => onSend(entry, text)}
							placeholder={`Message ${entry.name}`}
						/>
					) : null}
				</>
			)}
		</section>
	);
}

function RecipientOption({
	active,
	entry,
	id,
	onPick,
}: {
	active: boolean;
	entry: MessengerEntry;
	id: string;
	onPick: (entry: MessengerEntry) => void;
}) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns the keys (aria-activedescendant)
		<div
			aria-selected={active}
			className={cn(
				"flex h-9 cursor-default items-center gap-2.5 rounded-md px-2",
				active ? "bg-muted" : "hover:bg-muted/60"
			)}
			data-recipient={entry.key}
			id={id}
			onClick={() => onPick(entry)}
			// Keep focus in the To: field while the pointer picks.
			onMouseDown={(event) => event.preventDefault()}
			role="option"
		>
			<MessengerAvatar entry={entry} ringClassName="ring-muted" size="chip" />
			<span className="shrink-0 font-medium text-sm">{entry.name}</span>
			{entry.description ? (
				<span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
					{entry.description}
				</span>
			) : null}
		</div>
	);
}

/**
 * "New message": a To: field with a typeahead list under it, as in
 * Messages. Picking a recipient turns it into a single chip; Backspace in
 * the empty field takes it back out.
 */
export function MessengerCompose({
	entries,
	initialKey,
	onBack,
	onSend,
}: {
	entries: MessengerEntry[];
	initialKey: string | null;
	onBack: () => void;
	onSend: (entry: MessengerEntry, text: string) => void;
}) {
	const [recipientKey, setRecipientKey] = useState<string | null>(initialKey);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const recipient = entries.find((entry) => entry.key === recipientKey);
	const matches = matchRecipients(entries, query);
	const toId = useId();
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const messageRef = useRef<HTMLTextAreaElement>(null);
	const listOpen = recipient === undefined;
	const active = matches[Math.min(activeIndex, matches.length - 1)];
	const optionId = (entry: MessengerEntry) =>
		`${listId}-${entry.key.replace(/[^\w-]/g, "_")}`;

	useEffect(() => {
		(recipientKey ? messageRef : inputRef).current?.focus();
	}, [recipientKey]);

	const pick = (entry: MessengerEntry) => {
		setRecipientKey(entry.key);
		setQuery("");
		setActiveIndex(0);
	};

	const onFieldKey = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Backspace" && recipient && !query) {
			event.preventDefault();
			setRecipientKey(null);
			return;
		}
		if (!listOpen || matches.length === 0) {
			return;
		}
		const step = LIST_STEP[event.key];
		if (step !== undefined) {
			event.preventDefault();
			setActiveIndex(
				(index) =>
					(Math.min(index, matches.length - 1) + step + matches.length) %
					matches.length
			);
		} else if (event.key === "Enter" && active) {
			event.preventDefault();
			pick(active);
		}
	};

	return (
		<section
			aria-label="New message"
			className="flex size-full min-h-0 flex-col"
		>
			<HeaderBar>
				<BackButton onBack={onBack} />
				<HeaderTitle className="flex-1">New message</HeaderTitle>
			</HeaderBar>
			<div className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-4">
				<label className="text-muted-foreground text-sm" htmlFor={toId}>
					To:
				</label>
				{recipient ? (
					<span
						className="flex h-6 shrink-0 items-center gap-1 rounded-full bg-primary/10 pr-1 pl-2.5 font-medium text-primary text-sm"
						data-testid="messenger-recipient"
					>
						{recipient.name}
						<button
							aria-label={`Remove ${recipient.name}`}
							className="flex size-4 items-center justify-center rounded-full outline-none hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => setRecipientKey(null)}
							type="button"
						>
							<X aria-hidden="true" className="size-3" />
						</button>
					</span>
				) : null}
				<input
					aria-activedescendant={
						listOpen && active ? optionId(active) : undefined
					}
					aria-autocomplete="list"
					aria-controls={listOpen ? listId : undefined}
					aria-expanded={listOpen}
					autoComplete="off"
					className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
					id={toId}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveIndex(0);
					}}
					onKeyDown={onFieldKey}
					placeholder={recipient ? "" : "Agent or team"}
					ref={inputRef}
					role="combobox"
					type="text"
					value={query}
				/>
			</div>
			{listOpen ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
					{matches.length > 0 ? (
						<div
							aria-label="Recipients"
							className="flex max-w-md flex-col gap-0.5"
							id={listId}
							role="listbox"
						>
							{matches.map((entry) => (
								<RecipientOption
									active={entry === active}
									entry={entry}
									id={optionId(entry)}
									key={entry.key}
									onPick={pick}
								/>
							))}
						</div>
					) : (
						<p
							className="px-2 py-1.5 text-muted-foreground text-sm"
							role="status"
						>
							No agents or teams match “{query.trim()}”.
						</p>
					)}
				</div>
			) : (
				<ConversationStart entry={{ ...recipient, threadIds: [] }} />
			)}
			<MessengerComposer
				disabledReason={recipient ? undefined : "Pick a recipient first."}
				inputRef={messageRef}
				label="New message"
				onSend={(text) => {
					if (recipient) {
						onSend(recipient, text);
					}
				}}
				placeholder={recipient ? `Message ${recipient.name}` : "Message"}
			/>
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
