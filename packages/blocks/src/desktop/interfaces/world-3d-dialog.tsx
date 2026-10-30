import { useLiteralMessages } from "@ryu/i18n/react";
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
import { type KeyboardEvent, type ReactNode, useId, useState } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import { plainText } from "./interface-ask-card.tsx";
import { compactAge } from "./interface-renderer.ts";
import { DialogComposer } from "./world-3d-dialog-composer.tsx";
import { ROW, STATUS_TEXT } from "./world-3d-dialog-styles.ts";
import { ThreadPanel } from "./world-3d-dialog-thread-panel.tsx";
import { HUD_SURFACE, Keycap } from "./world-3d-hud.tsx";
import {
	actLine,
	agentUrgencies,
	isUrgent,
	SHORT_STATUS_LABELS,
	shortStatusLabel,
	spokenLine,
} from "./world-3d-model.ts";

export { THREAD_PANEL_WIDTH } from "./world-3d-dialog-styles.ts";
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

/** Height of the dialogue box; the interface lifts the view by half of it. */
export const BAND_HEIGHT = 210;
/** Width the choices take on the right of the dialogue (`w-80`). */
export const CHOICES_WIDTH = 320;

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
	const tl = useLiteralMessages();
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
					aria-label={`${sentence(tl("Answer: {answer}", { answer: answerText(ask, acts.privacy) }))} ${askAriaLabel(
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
						{tl("Answer: {answer}", {
							answer: answerText(ask, acts.privacy),
						})}
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
	const tl = useLiteralMessages();
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape" && !event.defaultPrevented) {
			event.preventDefault();
			onClose();
		}
	};
	return (
		<aside
			aria-label={tl("Talking to {name}", { name: agent.name })}
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
