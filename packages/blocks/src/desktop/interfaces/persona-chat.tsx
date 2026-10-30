import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type InterfaceAgent,
	type InterfaceThread,
	THREAD_STATUS_LABELS,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight, Plus, Sparkles, X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { compactAge } from "./interface-renderer.ts";
import { PersonaAvatar } from "./persona-avatar.tsx";
import { PersonaComposer } from "./persona-composer.tsx";
import {
	clockTime,
	countLabel,
	dayLabel,
	fullTime,
	type PersonaIdea,
} from "./persona-model.ts";
import { PERSONA_COLUMN } from "./persona-parts.tsx";

const CHIP =
	"inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

function chipState(selected: boolean): string {
	return selected
		? "border-transparent bg-accent font-medium text-accent-foreground"
		: "border-border bg-background text-foreground hover:bg-muted";
}

/**
 * The persona's conversations as a strip above the chat: the main chat
 * first, then side chats newest first, then "New side chat".
 */
function SideChatStrip({
	activeThreadId,
	agent,
	composing,
	main,
	onClose,
	onNewSideChat,
	onOpen,
	sides,
}: {
	activeThreadId: string | null;
	agent: InterfaceAgent;
	composing: boolean;
	main: InterfaceThread | undefined;
	/** Set while a chat is open: closes it back to the preview. */
	onClose: (() => void) | null;
	onNewSideChat: () => void;
	onOpen: (threadId: string) => void;
	sides: InterfaceThread[];
}) {
	const tl = useLiteralMessages();
	return (
		<div className="shrink-0 border-border border-b bg-muted/30">
			<div className={cn(PERSONA_COLUMN, "flex items-center gap-1 pb-2")}>
				<nav
					aria-label={tl("Chats with {name}", { name: agent.name })}
					className="-ml-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-1 pr-6 pl-1 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none]"
				>
					{main ? (
						<button
							aria-current={activeThreadId === main.id ? "true" : undefined}
							aria-label={tl("Main chat: {title}", {
								title: main.title || "Untitled",
							})}
							className={cn(
								CHIP,
								"pl-1.5",
								chipState(activeThreadId === main.id)
							)}
							onClick={() => onOpen(main.id)}
							type="button"
						>
							<PersonaAvatar agent={agent} size={20} />
							<span className="font-medium">Main chat</span>
						</button>
					) : null}
					{sides.length > 0 ? (
						<span
							aria-hidden="true"
							className="mx-1 h-5 w-px shrink-0 bg-border"
						/>
					) : null}
					{sides.length > 0 ? (
						<span className="@max-[639px]:hidden shrink-0 pr-1 text-muted-foreground text-xs">
							Side chats
						</span>
					) : null}
					{sides.map((thread) => {
						const status = threadStatus(thread);
						const selected = activeThreadId === thread.id;
						return (
							<button
								aria-current={selected ? "true" : undefined}
								aria-label={`${thread.title || "Untitled"}, ${THREAD_STATUS_LABELS[status]}`}
								className={cn(CHIP, chipState(selected))}
								key={thread.id}
								onClick={() => onOpen(thread.id)}
								title={thread.title}
								type="button"
							>
								<BoardStatusDot status={status} />
								<span className="max-w-52 truncate">
									{thread.title || "Untitled"}
								</span>
							</button>
						);
					})}
				</nav>
				<Button
					aria-label="New side chat"
					aria-pressed={composing}
					className={cn(
						"@max-[639px]:size-8 shrink-0 @max-[639px]:px-0",
						composing && "bg-accent text-accent-foreground"
					)}
					onClick={onNewSideChat}
					size="sm"
					title="New side chat"
					type="button"
					variant="ghost"
				>
					<Plus aria-hidden="true" />
					<span className="@max-[639px]:hidden">New side chat</span>
				</Button>
				{onClose ? (
					<Button
						aria-keyshortcuts="Escape"
						aria-label="Close chat"
						className="shrink-0 text-muted-foreground"
						onClick={onClose}
						size="icon-sm"
						title="Close chat (Esc)"
						type="button"
						variant="ghost"
					>
						<X aria-hidden="true" />
					</Button>
				) : null}
			</div>
		</div>
	);
}

/** The messaging frame the preview, a new side chat and the host's chat sit
 * in: the shared Persona column on the page background. */
const FRAME = "flex min-h-0 flex-1 flex-col";
const FRAME_COLUMN = cn(PERSONA_COLUMN, "flex min-h-0 flex-1 flex-col");

/** A centred date marker, as messaging apps put above a day's messages. */
function DayMarker({ iso }: { iso: string }) {
	return (
		<p className="self-center rounded-md border border-border bg-background px-2.5 py-0.5 font-medium text-foreground/70 text-xs">
			{dayLabel(iso)}
		</p>
	);
}

/** Past this length a main-thread preview is likely clamped, so it offers the
 * full message. Six lines of the preview column hold roughly this much. */
const LONG_PREVIEW_CHARS = 360;

/**
 * The main chat as you land on it: the latest message anchored above a
 * message bar, WhatsApp style. Earlier messages and the bar both open the
 * host's real conversation; nothing here sends.
 */
function MainPreview({
	agent,
	main,
	onOpen,
	onSuggest,
	suggestions,
}: {
	agent: InterfaceAgent;
	main: InterfaceThread;
	onOpen: (threadId: string) => void;
	/** Starts a side chat with the suggestion as an editable draft. */
	onSuggest: (prompt: string) => void;
	suggestions: readonly PersonaIdea[];
}) {
	const fromUser = main.lastMessageRole === "user";
	const earlier = Math.max(0, main.messageCount - (main.lastMessage ? 1 : 0));
	const { name } = agent;
	const age = compactAge(main.updatedAt);
	const tl = useLiteralMessages();
	return (
		<div className={FRAME}>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div
					className={cn(
						PERSONA_COLUMN,
						"flex flex-1 flex-col justify-end gap-3 py-6"
					)}
				>
					{earlier > 0 ? (
						<button
							className="self-center rounded-md px-2.5 py-1 font-medium text-foreground/70 text-xs outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
							onClick={() => onOpen(main.id)}
							type="button"
						>
							{countLabel(earlier, "earlier message")}
						</button>
					) : null}
					<DayMarker iso={main.updatedAt} />
					{main.lastMessage ? (
						<div
							className={cn(
								"flex max-w-[85%] items-end gap-2",
								fromUser ? "self-end" : "self-start"
							)}
						>
							{fromUser ? null : <PersonaAvatar agent={agent} size={32} />}
							<p
								className={cn(
									"flex flex-col gap-1 rounded-2xl px-3.5 py-2 text-sm leading-6",
									fromUser
										? "rounded-br-md bg-primary text-primary-foreground"
										: "rounded-bl-md bg-muted text-foreground"
								)}
							>
								{/* Main threads read like a feed: a long reply is clamped
								    here and opens in full in the real thread. */}
								<span className="line-clamp-6 whitespace-pre-line">
									{main.lastMessage}
								</span>
								{main.lastMessage.length > LONG_PREVIEW_CHARS ? (
									<button
										className={cn(
											"self-start font-medium text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
											fromUser
												? "text-primary-foreground/80"
												: "text-foreground/70"
										)}
										onClick={() => onOpen(main.id)}
										type="button"
									>
										Read the full message
									</button>
								) : null}
								<time
									className={cn(
										"self-end text-[11px] tabular-nums leading-4",
										fromUser
											? "text-primary-foreground/70"
											: "text-foreground/60"
									)}
									dateTime={main.updatedAt}
									title={fullTime(main.updatedAt)}
								>
									{clockTime(main.updatedAt)}
								</time>
							</p>
						</div>
					) : (
						<p className="self-center text-muted-foreground text-sm">
							No messages yet
						</p>
					)}
					{main.running ? (
						<p className="flex items-center gap-2 self-start pl-10 text-muted-foreground text-xs">
							<BoardStatusDot status="working" />
							{tl("{name} is working · updated {age}", { age, name })}
						</p>
					) : null}
				</div>
			</div>
			<div className="shrink-0 border-border border-t">
				<div className={cn(PERSONA_COLUMN, "flex flex-col gap-3 py-3")}>
					{suggestions.length > 0 ? (
						<ul
							aria-label="Suggestions"
							className="flex gap-2 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none]"
						>
							{suggestions.slice(0, 3).map((idea) => (
								<li className="min-w-0 shrink-0" key={idea.id}>
									<button
										className="flex h-8 max-w-72 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => onSuggest(idea.prompt)}
										title={idea.prompt}
										type="button"
									>
										<Sparkles
											aria-hidden="true"
											className="size-3.5 shrink-0 text-muted-foreground"
										/>
										<span className="truncate">{idea.prompt}</span>
									</button>
								</li>
							))}
						</ul>
					) : null}
					<button
						className="group/open flex h-10 w-full items-center gap-3 rounded-[20px] border border-border bg-background pr-3 pl-4 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => onOpen(main.id)}
						type="button"
					>
						<span className="min-w-0 flex-1 truncate font-medium">
							{tl("Open chat with {name}", { name })}
						</span>
						<ChevronRight
							aria-hidden="true"
							className="size-4 shrink-0 text-muted-foreground transition-transform motion-safe:group-hover/open:translate-x-0.5"
						/>
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Escape anywhere in the open chat (strip or frame) closes it back to the
 * preview, unless something inside (a menu, the host composer) used it.
 */
function useEscapeToClose(onClose: (() => void) | null) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const element = ref.current;
		if (!(element && onClose)) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				onClose();
			}
		};
		element.addEventListener("keydown", onKeyDown);
		return () => element.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	return ref;
}

/** Starting a conversation: the first one with this persona, or a side chat.
 * Only text the user typed and sent here reaches `startThread`. */
function StartChat({
	agent,
	draft,
	fieldRef,
	first,
	onCancel,
	onDraftChange,
	onSend,
}: {
	agent: InterfaceAgent;
	draft: string;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	first: boolean;
	onCancel: (() => void) | null;
	onDraftChange: (value: string) => void;
	onSend: (prompt: string) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className={FRAME}>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div
					className={cn(
						PERSONA_COLUMN,
						"flex flex-1 flex-col items-center justify-end gap-3 pt-8 pb-6 text-center"
					)}
				>
					<PersonaAvatar agent={agent} size={48} />
					<div className="flex flex-col gap-1">
						<h2 className="font-medium text-base">
							{first
								? tl("Start chatting with {name}", { name: agent.name })
								: "New side chat"}
						</h2>
						<p className="max-w-sm text-balance text-muted-foreground text-sm">
							{first
								? "Your first message becomes the main chat."
								: tl(
										"A separate chat with {name} for one topic. Main chat stays as it is.",
										{ name: agent.name }
									)}
						</p>
					</div>
					{onCancel ? (
						<Button
							onClick={onCancel}
							size="sm"
							type="button"
							variant="ghost-muted"
						>
							Cancel
						</Button>
					) : null}
				</div>
			</div>
			<div className="shrink-0 border-border border-t">
				<div className={cn(PERSONA_COLUMN, "py-3")}>
					<PersonaComposer
						fieldRef={fieldRef}
						label={tl("Message {name}", { name: agent.name })}
						onChange={onDraftChange}
						onSubmit={onSend}
						placeholder={tl("Message {name}", { name: agent.name })}
						value={draft}
					/>
				</div>
			</div>
		</div>
	);
}

/** Chat: the persona's main conversation is the host's own chat surface
 * (`threadView`) in a messaging frame, with side chats above it. */
export function PersonaChat({
	activeThreadId,
	agent,
	composing,
	draft,
	fieldRef,
	main,
	onCancelCompose,
	onClose,
	onDraftChange,
	onNewSideChat,
	onOpen,
	onSend,
	onSuggest,
	sides,
	suggestions,
	threadView,
}: {
	activeThreadId: string | null;
	agent: InterfaceAgent;
	composing: boolean;
	draft: string;
	fieldRef: RefObject<HTMLTextAreaElement | null>;
	main: InterfaceThread | undefined;
	onCancelCompose: () => void;
	onClose: () => void;
	onDraftChange: (value: string) => void;
	onNewSideChat: () => void;
	onOpen: (threadId: string) => void;
	onSend: (prompt: string) => void;
	onSuggest: (prompt: string) => void;
	sides: InterfaceThread[];
	suggestions: readonly PersonaIdea[];
	threadView: ReactNode | null;
}) {
	const chatRef = useEscapeToClose(threadView === null ? null : onClose);
	let body: ReactNode;
	if (threadView !== null) {
		body = (
			<div className={FRAME} data-persona-thread="">
				<div className={FRAME_COLUMN}>{threadView}</div>
			</div>
		);
	} else if (composing || !main) {
		body = (
			<StartChat
				agent={agent}
				draft={draft}
				fieldRef={fieldRef}
				first={!main}
				onCancel={main ? onCancelCompose : null}
				onDraftChange={onDraftChange}
				onSend={onSend}
			/>
		);
	} else {
		body = (
			<MainPreview
				agent={agent}
				main={main}
				onOpen={onOpen}
				onSuggest={onSuggest}
				suggestions={suggestions}
			/>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col" ref={chatRef}>
			{main || threadView !== null ? (
				<SideChatStrip
					activeThreadId={activeThreadId}
					agent={agent}
					composing={composing && threadView === null}
					main={main}
					onClose={threadView === null ? null : onClose}
					onNewSideChat={onNewSideChat}
					onOpen={onOpen}
					sides={sides}
				/>
			) : null}
			{body}
		</div>
	);
}
