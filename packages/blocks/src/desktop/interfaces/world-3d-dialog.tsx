import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	askAriaLabel,
	askKindWords,
	type InterfaceAgent,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfacePort,
	type InterfaceThread,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { ArrowLeft, X } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type SyntheticEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { plainText } from "./interface-ask-card.tsx";
import { compactAge } from "./interface-renderer.ts";
import { HUD_SURFACE, Keycap } from "./world-3d-hud.tsx";
import {
	actLine,
	agentUrgencies,
	isUrgent,
	SHORT_STATUS_LABELS,
	shortStatusLabel,
	spokenLine,
} from "./world-3d-model.ts";

export { spokenLine } from "./world-3d-model.ts";

/**
 * Conversations in the 3D world, staged like an action-RPG dialogue and
 * drawn with the user's theme:
 *
 * - talking to an agent: a dialogue box on the bottom left with the
 *   speaker's name and their line, and the choices (a new conversation,
 *   past conversations with their status, walk away) as one list on the
 *   right; "New conversation" swaps the line for a composer;
 * - a conversation open: the host's thread view in a panel on the right,
 *   leaving the left of the screen to the camera's two-shot of the player
 *   and the agent.
 *
 * The whole dialogue is one region labeled "Talking to <name>".
 */

const MAX_PROMPT_LENGTH = 8000;
/** Panel width when a conversation is open; the interface shifts the view by it. */
export const THREAD_PANEL_WIDTH = "clamp(360px, 46vw, 680px)";
/** Height of the dialogue box; the interface lifts the view by half of it. */
export const BAND_HEIGHT = 210;
/** Width the choices take on the right of the dialogue (`w-80`). */
export const CHOICES_WIDTH = 320;

/**
 * A choice row, inset from the list's edges so its radius sits inside the
 * panel's; hover and keyboard focus both fill it, as menu items do.
 */
const ROW =
	"mx-1 flex h-10 w-[calc(100%-0.5rem)] items-center gap-3 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground";

/** Only what asks for the user is colored; the rest reads as metadata. */
const STATUS_TEXT: Record<ThreadStatus, string> = {
	attention: "text-destructive",
	quiet: "text-muted-foreground",
	waiting: "text-muted-foreground",
	working: "text-muted-foreground",
	"your-turn": "text-primary",
};

/**
 * What the agent's presence word says: working while it runs, else what its
 * most pressing conversation asks of the user (worded as that conversation's
 * row is, so a stopped run reads "Interrupted"), else idle.
 */
function presence(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[]
): { label: string; state: ThreadStatus | "idle" } {
	if (agent.status === "working") {
		return { label: SHORT_STATUS_LABELS.working, state: "working" };
	}
	const urgency = agentUrgencies(threads).get(agent.id);
	return urgency && isUrgent(urgency.status)
		? { label: shortStatusLabel(urgency.thread), state: urgency.status }
		: { label: "Idle", state: "idle" };
}

/** The agent's presence and role, on one line that truncates. */
function StatusLine({
	agent,
	threads,
}: {
	agent: InterfaceAgent;
	threads: readonly InterfaceThread[];
}) {
	const { label, state } = presence(agent, threads);
	return (
		<p className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs leading-4">
			<span
				className={cn(
					"inline-flex shrink-0 items-center gap-1.5",
					state !== "idle" && "font-medium",
					state === "idle" ? null : STATUS_TEXT[state]
				)}
			>
				{state === "working" ? <BoardStatusDot status="working" /> : null}
				{label}
			</span>
			{agent.description ? (
				<>
					<span aria-hidden="true">·</span>
					<span className="min-w-0 truncate">{agent.description}</span>
				</>
			) : null}
		</p>
	);
}

/** Composer for a new conversation, inside the dialogue box. */
function DialogComposer({
	agent,
	onCancel,
	onSubmit,
}: {
	agent: InterfaceAgent;
	onCancel: () => void;
	onSubmit: (prompt: string) => void;
}) {
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const field = useRef<HTMLTextAreaElement>(null);
	// Opening the composer is an explicit request to type: focus the field.
	useEffect(() => {
		field.current?.focus();
	}, []);
	const trimmed = prompt.trim();
	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit(trimmed);
		setPrompt("");
	};
	const onFormSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			onCancel();
			return;
		}
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			submit();
		}
	};
	return (
		<form className="flex w-full flex-col gap-2" onSubmit={onFormSubmit}>
			<label className="sr-only" htmlFor={fieldId}>
				Say something to {agent.name}
			</label>
			<textarea
				aria-describedby={hintId}
				className="max-h-28 min-h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-foreground text-sm leading-5 outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={`Say something to ${agent.name}`}
				ref={field}
				rows={2}
				value={prompt}
			/>
			<div className="flex items-center justify-between gap-3">
				<p className="text-muted-foreground text-xs" id={hintId}>
					Enter to send · Shift+Enter for a new line · Esc to cancel
				</p>
				<Button disabled={!trimmed} size="sm" type="submit">
					Send
				</Button>
			</div>
		</form>
	);
}

/** One past conversation: its title, status word (unless quiet) and age. */
function ThreadRow({
	acted = false,
	onOpen,
	thread,
}: {
	/** The act layer is on: no age from `updatedAt` (it is not when anything happened). */
	acted?: boolean;
	onOpen: (threadId: string) => void;
	thread: InterfaceThread;
}) {
	const status = threadStatus(thread);
	return (
		<li>
			<button className={ROW} onClick={() => onOpen(thread.id)} type="button">
				<span className="min-w-0 flex-1 truncate">
					{thread.title || "Untitled"}
				</span>
				<span
					className={cn(
						"w-16 shrink-0 text-right text-xs",
						isUrgent(status) && "font-medium",
						STATUS_TEXT[status]
					)}
				>
					{status === "quiet" || acted ? null : shortStatusLabel(thread)}
				</span>
				{acted ? null : (
					<span className="w-7 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
						{compactAge(thread.updatedAt)}
					</span>
				)}
			</button>
		</li>
	);
}

/** The act layer in the dialogue: what the agent says and its asks. */
export interface DialogActs {
	act: InterfaceAgentAct;
	/** Who asks, for each row's accessible name. */
	agentName: string;
	asks: readonly InterfaceAsk[];
	nowMs: number;
	/** Opens the shared ask card (the dialogue never answers by itself). */
	onAsk: (askId: string, opener: HTMLElement) => void;
	privacy: "full" | "redacted";
}

/** An answer row's words: the ask itself, or only its kind under redaction. */
export /** Ends `text` as a sentence (adds a period unless it already ends one). */
function sentence(text: string): string {
	return /[.?!]$/.test(text) ? text : `${text}.`;
}

function answerText(ask: InterfaceAsk, privacy: "full" | "redacted"): string {
	return privacy === "redacted"
		? askKindWords(ask)
		: plainText(ask.text) || askKindWords(ask);
}

/** The choices on the right: answers, new conversation, past conversations, leave. */
function Choices({
	acts,
	composing,
	onClose,
	onCompose,
	onOpen,
	threads,
}: {
	acts?: DialogActs;
	composing: boolean;
	onClose: () => void;
	onCompose: () => void;
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const headingId = useId();
	return (
		<nav
			aria-label="Dialogue options"
			className={cn(HUD_SURFACE, "flex flex-col overflow-hidden py-1")}
		>
			{/* One row per ask of this agent: it opens the shared ask card. */}
			{acts?.asks.map((ask) => (
				<button
					// The visible words lead the name (label in name).
					aria-label={`${sentence(`Answer: ${answerText(ask, acts.privacy)}`)} ${askAriaLabel(
						ask,
						acts.agentName,
						acts.nowMs,
						acts.privacy
					)}`}
					className={ROW}
					data-dialog-ask={ask.id}
					key={ask.id}
					onClick={(event) => acts.onAsk(ask.id, event.currentTarget)}
					type="button"
				>
					<span className="min-w-0 flex-1 truncate font-medium">
						Answer: {answerText(ask, acts.privacy)}
					</span>
				</button>
			))}
			{composing ? null : (
				<button className={ROW} onClick={onCompose} type="button">
					<span className="flex-1 font-medium">New conversation</span>
				</button>
			)}
			{threads.length > 0 ? (
				<section
					aria-labelledby={headingId}
					className={cn(
						"flex flex-col",
						!composing && "mt-1 border-border border-t pt-1"
					)}
				>
					<h3
						className="px-3 pt-2 pb-1 font-medium text-muted-foreground text-xs leading-4"
						id={headingId}
					>
						Past conversations
					</h3>
					<ul className="flex max-h-[min(12.5rem,36vh)] flex-col overflow-y-auto">
						{threads.map((thread) => (
							<ThreadRow
								acted={acts !== undefined}
								key={thread.id}
								onOpen={onOpen}
								thread={thread}
							/>
						))}
					</ul>
				</section>
			) : null}
			<div className="mt-1 border-border border-t pt-1">
				<button
					aria-label="Walk away"
					className={ROW}
					onClick={onClose}
					type="button"
				>
					<span className="flex-1">Walk away</span>
					<Keycap aria-hidden="true">Esc</Keycap>
				</button>
			</div>
		</nav>
	);
}

/** The dialogue box and choices shown while talking, before a thread opens. */
function DialogueBand({
	acts,
	agent,
	onClose,
	port,
	threads,
}: {
	acts?: DialogActs;
	agent: InterfaceAgent;
	onClose: () => void;
	port: InterfacePort;
	threads: InterfaceThread[];
}) {
	const [composing, setComposing] = useState(false);
	const line = acts
		? actLine(acts.act, threads, acts.privacy)
		: spokenLine(agent, threads);
	return (
		<div className="absolute inset-x-0 bottom-0 flex @max-[720px]:flex-col items-end @max-[720px]:items-stretch gap-3 @max-[720px]:p-3 p-6">
			<section
				className={cn(
					HUD_SURFACE,
					"relative mt-3.5 flex min-w-0 @max-[720px]:max-w-none max-w-[40rem] flex-1 flex-col gap-2 px-5 pt-6 pb-5"
				)}
				data-testid="world-3d-dialogue"
			>
				<header className="flex min-w-0 flex-col">
					{/* The speaker's name tab sits on the box's top edge. */}
					<h2 className="absolute -top-3.5 left-5 flex h-7 max-w-[calc(100%-40px)] items-center truncate rounded-md bg-primary px-3 font-semibold text-primary-foreground text-sm">
						{agent.name}
					</h2>
					{acts ? (
						// The act sentence in place of the legacy presence words.
						<p className="min-w-0 truncate text-muted-foreground text-xs leading-4">
							{acts.act.ariaLabel}
						</p>
					) : (
						<StatusLine agent={agent} threads={threads} />
					)}
				</header>
				{composing ? (
					<DialogComposer
						agent={agent}
						key={agent.id}
						onCancel={() => setComposing(false)}
						onSubmit={(prompt) =>
							port.startThread({ agentId: agent.id, prompt })
						}
					/>
				) : (
					<blockquote className="line-clamp-3 text-base text-foreground leading-6">
						{line}
					</blockquote>
				)}
			</section>
			<div
				className="@max-[720px]:ml-0 ml-auto @max-[720px]:w-full w-80 shrink-0"
				data-testid="world-3d-choices"
			>
				<Choices
					acts={acts}
					composing={composing}
					onClose={onClose}
					onCompose={() => setComposing(true)}
					onOpen={port.openThread}
					threads={threads}
				/>
			</div>
		</div>
	);
}

/**
 * Who the open conversation is with and where it stands: the agent, then
 * the thread's own status (not the agent's presence, which can differ).
 */
function ThreadSubline({
	acted = false,
	agent,
	thread,
}: {
	/** The act layer is on: no thread status word (the acts say it). */
	acted?: boolean;
	agent: InterfaceAgent;
	thread: InterfaceThread | undefined;
}) {
	const status = thread ? threadStatus(thread) : null;
	return (
		<p className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs leading-4">
			<span className="min-w-0 truncate">{agent.name}</span>
			{status && status !== "quiet" && !acted ? (
				<>
					<span aria-hidden="true">·</span>
					<span
						className={cn(
							"inline-flex shrink-0 items-center gap-1.5",
							isUrgent(status) && "font-medium",
							STATUS_TEXT[status]
						)}
					>
						{status === "working" ? <BoardStatusDot status="working" /> : null}
						{thread ? shortStatusLabel(thread) : SHORT_STATUS_LABELS[status]}
					</span>
				</>
			) : null}
		</p>
	);
}

/** The host's thread view in a panel on the right, titled by the thread. */
function ThreadPanel({
	acted = false,
	agent,
	onClose,
	port,
	thread,
	threadView,
}: {
	acted?: boolean;
	agent: InterfaceAgent;
	onClose: () => void;
	port: InterfacePort;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	return (
		<div
			className="pointer-events-auto absolute top-0 right-0 bottom-0 flex max-w-full flex-col overflow-hidden border-border border-l bg-card text-card-foreground"
			data-testid="world-3d-thread-panel"
			style={{ width: THREAD_PANEL_WIDTH }}
		>
			{/* The back arrow's glyph lands on the thread's 16px gutter. */}
			<header className="flex h-14 shrink-0 items-center gap-1 border-border border-b px-4">
				<Button
					aria-label="Back to conversations"
					className="-ml-2"
					onClick={port.closeThread}
					size="icon-sm"
					title="Back to conversations"
					type="button"
					variant="ghost-muted"
				>
					<ArrowLeft aria-hidden="true" />
				</Button>
				<div className="flex min-w-0 flex-1 flex-col">
					<h2 className="truncate font-semibold text-foreground text-sm leading-5">
						{thread ? thread.title || "Untitled" : agent.name}
					</h2>
					<ThreadSubline acted={acted} agent={agent} thread={thread} />
				</div>
				<Button
					aria-keyshortcuts="Escape"
					aria-label="Walk away"
					className="-mr-2"
					onClick={onClose}
					size="icon-sm"
					title="Walk away (Esc)"
					type="button"
					variant="ghost-muted"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1 overflow-hidden bg-background text-foreground">
				{threadView}
			</div>
		</div>
	);
}

/**
 * The dialogue for the agent the player is talking to. Escape anywhere in
 * it walks away (the composer's own Escape only closes the composer).
 */
export function World3dDialog({
	activeThreadId = null,
	acts,
	agent,
	onClose,
	port,
	threads,
	threadView,
}: {
	/** The open conversation, which titles the thread panel. */
	activeThreadId?: string | null;
	/** The act layer: this agent's act and asks (a snapshot with `asks`). */
	acts?: DialogActs;
	agent: InterfaceAgent;
	onClose: () => void;
	port: InterfacePort;
	threads: InterfaceThread[];
	threadView: ReactNode | null;
}) {
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && !event.defaultPrevented) {
			event.preventDefault();
			onClose();
		}
	};
	return (
		<aside
			aria-label={`Talking to ${agent.name}`}
			className="@container pointer-events-none absolute inset-0 z-[500] font-sans [&_button]:pointer-events-auto [&_form]:pointer-events-auto [&_nav]:pointer-events-auto [&_section]:pointer-events-auto"
			data-testid="world-agent-panel"
			onKeyDown={onKeyDown}
		>
			{threadView ? (
				<ThreadPanel
					acted={acts !== undefined}
					agent={agent}
					onClose={onClose}
					port={port}
					thread={threads.find((item) => item.id === activeThreadId)}
					threadView={threadView}
				/>
			) : (
				<DialogueBand
					acts={acts}
					agent={agent}
					key={agent.id}
					onClose={onClose}
					port={port}
					threads={threads}
				/>
			)}
		</aside>
	);
}
