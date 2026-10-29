import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceAgentAct,
	InterfacePort,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { threadStatus } from "@ryuhq/protocol/interfaces";
import {
	type ComponentProps,
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useContext,
	useId,
	useState,
} from "react";
import { compactAge } from "./interface-renderer.ts";
import { frameStyle, SV_PLANK_TEXT, SV_TEXT } from "./world-2d-frame.ts";
import {
	CloseButton,
	PixelKey,
	QuestMark,
	WorkingDots,
} from "./world-2d-hud.tsx";
import {
	needsYou,
	type VillagerStatus,
	villagerStatusLabel,
} from "./world-2d-model.ts";
import { SV_UI } from "./world-2d-palette.ts";
import { PixelPortrait } from "./world-2d-portrait.tsx";

const MAX_PROMPT_LENGTH = 8000;

/**
 * The talk panel, drawn as a Stardew Valley dialogue box: wooden frames with
 * parchment insides, the villager's framed portrait over a flat name plate,
 * their line in the box with where they stand with you, past conversations
 * as dialogue choices (each marked with its status), and the reply box
 * pinned to the bottom. When a thread is open the host's real chat sits in
 * the same wood frame, in the user's own theme: only the frame is game art.
 *
 * Type: one face (the HUD's), 16px for the villager's line and 13px for
 * everything else, one weight.
 */

const UI_TYPE =
	"font-(family-name:--sv-font) font-normal [font-synthesis:none]";

/** A small wooden plank button that presses down. */
const PLANK_BUTTON = cn(
	"inline-flex h-8 items-center gap-2 text-[16px] leading-none outline-none hover:brightness-110 focus-visible:outline-(--sv-focus) focus-visible:outline-2 focus-visible:outline-offset-2 active:translate-y-px",
	UI_TYPE
);

/** Wooden backing behind the frames: horizontal planks on the pixel grid. */
const PANEL_BACKING = {
	backgroundColor: SV_UI.wallFill,
	backgroundImage: `repeating-linear-gradient(180deg, ${SV_UI.wallPlank} 0 21px, ${SV_UI.wallGap} 21px 24px), repeating-linear-gradient(90deg, transparent 0 117px, ${SV_UI.wallDark} 117px 120px)`,
} as const;

/** A pixel back arrow for the plank button. */
function BackIcon() {
	return (
		<svg
			aria-hidden="true"
			height="12"
			shapeRendering="crispEdges"
			viewBox="0 0 4 6"
			width="8"
		>
			<path d="M3 0h1v6h-1v-1h-1v-1h-1v-2h1v-1h1z" fill={SV_UI.plankInk} />
		</svg>
	);
}

/**
 * The pointing glove Stardew shows beside the current choice: the hovered
 * or focused one, and the first one while the list is at rest.
 */
function ChoiceGlove() {
	return (
		<span aria-hidden="true" className="flex w-[18px] shrink-0 justify-center">
			<svg
				className="invisible group-hover:visible group-focus-visible:visible [ul:not(:hover):not(:focus-within)>li:first-child_&]:visible"
				height="14"
				shapeRendering="crispEdges"
				viewBox="0 0 9 7"
				width="18"
			>
				<path
					d="M0 1h5v-1h2v1h1v1h1v3h-1v1h-1v1h-5v-1h-1v-1h-1z"
					fill={SV_UI.woodDark}
				/>
				<path d="M1 2h5v-1h1v1h1v3h-1v1h-4v-1h-2z" fill={SV_UI.plankInk} />
				<path d="M3 4h4v1h-4z" fill={SV_UI.inkShadow} />
			</svg>
		</span>
	);
}

/**
 * The act layer is on (a snapshot with `asks`): conversation rows show no
 * legacy status mark or `updatedAt` age.
 */
export const World2dActed = createContext(false);

/**
 * With the act layer, what each villager says (by agent): its act in its
 * own voice, a stopped run's reason included. Agents with nothing to say
 * about an act are left out and greet you as before.
 */
export const World2dActLines = createContext<ReadonlyMap<
	string,
	string
> | null>(null);

/** A villager's line from its act, or null when it has nothing to report. */
export function world2dActLine(
	act: InterfaceAgentAct,
	threads: readonly InterfaceThread[],
	privacy: "full" | "redacted"
): string | null {
	switch (act.act) {
		case "working":
			return privacy === "full" && act.bubble?.text
				? `Hang on: ${act.bubble.text}.`
				: "Hang on, I'm in the middle of something.";
		case "delivering": {
			const thread = threads.find((item) => item.id === act.threadId);
			const summary = privacy === "full" ? thread?.outcome?.summary : null;
			return summary ?? "I have an answer for you.";
		}
		case "asking":
			return "I need you to decide something.";
		case "blocked": {
			const failed = act.blockers.find(
				(blocker) => blocker.kind !== "interrupted"
			);
			return failed
				? `My run stopped: ${failed.title}. Can you take a look?`
				: "My run was interrupted.";
		}
		case "limited": {
			// From the act's own words ("Limit hit, back 15:10", "Likely
			// limit"): the time when it is known, "likely" for an estimate.
			const text = act.bubble?.text ?? "";
			const back = /back (.+)$/.exec(text)?.[1];
			const head = text.startsWith("Likely")
				? "I think I've hit my limit."
				: "I've hit my limit for now.";
			return back ? `${head} I'll be back ${back}.` : head;
		}
		default:
			return null;
	}
}

/** A status mark for a villager or a conversation (nothing when quiet). */
function StatusMark({ status }: { status: VillagerStatus }) {
	let glyph: ReactNode = null;
	if (status === "attention" || status === "your-turn") {
		glyph = <QuestMark size={12} tone={status} />;
	} else if (status === "working") {
		glyph = <WorkingDots />;
	}
	if (glyph === null) {
		return null;
	}
	// A cap-height box, like the clock's tally rows, so the glyph centers on
	// the label instead of sitting on its baseline.
	return (
		<span className="flex h-3 w-4 shrink-0 items-center justify-center">
			{glyph}
		</span>
	);
}

/** The villager's framed portrait over a flat name plate. */
function PortraitCard({
	agent,
	lookIndex,
	small,
}: {
	agent: InterfaceAgent;
	lookIndex: number;
	small: boolean;
}) {
	return (
		<figure className="flex shrink-0 flex-col items-stretch gap-2 self-stretch">
			<div
				className="flex items-end justify-center overflow-hidden"
				style={frameStyle("slot", 2)}
			>
				{/* A narrow panel (or an open thread) gets the 2x bust. */}
				<PixelPortrait
					agentId={agent.id}
					className={cn("-mb-[4px]", small ? null : "@sm:hidden")}
					crop="bust"
					lookIndex={lookIndex}
					scale={2}
					working={agent.status === "working"}
				/>
				{small ? null : (
					<PixelPortrait
						agentId={agent.id}
						className="-mb-[4px] @sm:block hidden"
						crop="bust"
						lookIndex={lookIndex}
						scale={3}
						working={agent.status === "working"}
					/>
				)}
			</div>
			<figcaption
				className={cn(
					"mt-auto max-w-[148px] truncate border-(--sv-slot-shade) border-t-2 pt-2 text-center text-[16px] leading-5",
					UI_TYPE
				)}
			>
				{agent.name}
			</figcaption>
		</figure>
	);
}

const GREETINGS = [
	"What do you need?",
	"What are we working on today?",
	"Got something for me?",
	"Good to see you. What's up?",
] as const;

/** What the villager says about one conversation (the open thread). */
function threadLine(thread: InterfaceThread): string {
	const title = thread.title || "our last conversation";
	switch (threadStatus(thread)) {
		case "attention":
			return `I hit a snag on “${title}”. Take a look when you get a chance.`;
		case "your-turn":
			return `I finished up “${title}”. Tell me what's next.`;
		case "working":
			return `Hang on, I'm deep in “${title}”.`;
		case "waiting":
			return `Picking up where we left off on “${title}”.`;
		default:
			return `Here's where we left “${title}”.`;
	}
}

/**
 * What the villager says: about the open conversation when there is one,
 * otherwise a line in their own voice about where they stand with you.
 */
export function villagerLine(
	agent: InterfaceAgent,
	threads: readonly InterfaceThread[],
	status: VillagerStatus,
	brief: boolean,
	openThread: InterfaceThread | null = null
): string {
	if (openThread) {
		return threadLine(openThread);
	}
	if (status === "attention") {
		const stuck = threads.find(
			(thread) => threadStatus(thread) === "attention"
		);
		const line = stuck?.title
			? `I hit a snag on “${stuck.title}”.`
			: "I hit a snag on my last job.";
		return brief ? line : `${line} Take a look when you get a chance.`;
	}
	if (status === "your-turn") {
		const done = threads.find((thread) => threadStatus(thread) === "your-turn");
		const line = done?.title
			? `I finished up “${done.title}”.`
			: "I have an answer for you.";
		return brief ? line : `${line} Have a look and tell me what's next.`;
	}
	if (agent.status === "working" || status === "working") {
		const busy = threads.find((thread) => thread.running);
		const line = busy?.title
			? `Hang on, I'm deep in “${busy.title}”.`
			: "Hang on, I'm in the middle of something.";
		return brief ? line : `${line} Leave me a note and I'll get to it.`;
	}
	let hash = 0;
	for (const char of agent.id) {
		hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
	}
	const greeting = GREETINGS[hash % GREETINGS.length] ?? GREETINGS[0];
	return threads.length > 0
		? `Hey, it's ${agent.name} again. ${greeting}`
		: `Hi, I'm ${agent.name}. First time stopping by? ${greeting}`;
}

/**
 * The dialogue box: the villager's line beside the portrait, their role
 * under it, and where they stand with you on the bottom rule. With a thread
 * open, the line and the status speak about that thread and the portrait
 * shrinks to leave the room to the chat below.
 */
function DialogueBox({
	agent,
	compact,
	lookIndex,
	openThread,
	status,
	threads,
}: {
	agent: InterfaceAgent;
	/** A thread is open below: keep the box short. */
	compact: boolean;
	lookIndex: number;
	openThread: InterfaceThread | null;
	status: VillagerStatus;
	threads: readonly InterfaceThread[];
}) {
	const shown: VillagerStatus = openThread ? threadStatus(openThread) : status;
	const actLines = useContext(World2dActLines);
	const actLine = openThread ? null : actLines?.get(agent.id);
	const alert = needsYou(shown);
	let label = "First visit";
	if (openThread || threads.length > 0 || status !== "idle") {
		label = villagerStatusLabel(shown);
	}
	return (
		<section
			aria-label={`${agent.name} says`}
			className="flex shrink-0 items-stretch gap-4 p-1"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<p className={cn("text-[16px] leading-6", UI_TYPE)}>
					{actLine ?? villagerLine(agent, threads, status, compact, openThread)}
				</p>
				{agent.description ? (
					<p
						className={cn(
							"text-(--sv-ink-soft) text-[16px] leading-6",
							UI_TYPE
						)}
					>
						<span className="sr-only">Role: </span>
						{agent.description}
					</p>
				) : null}
				<p
					className={cn(
						"mt-auto flex flex-wrap items-center gap-x-2 border-(--sv-ink-shadow) border-t-2 pt-2 text-[16px] leading-5",
						UI_TYPE
					)}
				>
					<StatusMark status={shown} />
					<span className={alert ? undefined : "text-(--sv-ink-soft)"}>
						{label}
					</span>
				</p>
			</div>
			<PortraitCard agent={agent} lookIndex={lookIndex} small={compact} />
		</section>
	);
}

/** The reply box the player types into to start a conversation. */
function ReplyBox({
	agent,
	onSubmit,
}: {
	agent: InterfaceAgent;
	onSubmit: (prompt: string) => void;
}) {
	const fieldId = useId();
	const hintId = useId();
	const [prompt, setPrompt] = useState("");
	const trimmed = prompt.trim();

	const submit = () => {
		if (!trimmed) {
			return;
		}
		onSubmit(trimmed);
		setPrompt("");
	};
	const onFormSubmit: ComponentProps<"form">["onSubmit"] = (event) => {
		event.preventDefault();
		submit();
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
		<form
			className="flex shrink-0 flex-col gap-2 p-1"
			onSubmit={onFormSubmit}
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<label className="sr-only" htmlFor={fieldId}>
				Say something to {agent.name}
			</label>
			<textarea
				aria-describedby={hintId}
				className={cn(
					"min-h-[72px] resize-none border-(--sv-slot-shade) border-2 bg-(--sv-parchment-field) px-3 py-2 text-(--sv-ink) text-[16px] leading-6 shadow-[inset_2px_2px_0_var(--sv-parchment-field-shade)] outline-none placeholder:text-(--sv-ink-soft)/70 focus-visible:border-(--sv-wood-dark)",
					UI_TYPE
				)}
				id={fieldId}
				maxLength={MAX_PROMPT_LENGTH}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={onKeyDown}
				placeholder={`Say something to ${agent.name}…`}
				value={prompt}
			/>
			<div className="flex min-h-8 items-center justify-between gap-2">
				<p
					className={cn(
						"flex items-center gap-1 text-(--sv-ink-soft) text-[16px] leading-none",
						UI_TYPE
					)}
					id={hintId}
				>
					<PixelKey>Enter</PixelKey> to send
				</p>
				{/* Enter sends; the button appears once there is something to say. */}
				{trimmed ? (
					<button
						className={PLANK_BUTTON}
						style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
						type="submit"
					>
						Say it
					</button>
				) : null}
			</div>
		</form>
	);
}

/**
 * Past conversations as Stardew dialogue choices: the parchment fills the
 * column down to the reply box (its rows scroll past that). The glove
 * and the highlight mark the current choice:
 * the hovered or focused row, or the latest one while the list is at rest.
 */
function DialogueChoices({
	onOpen,
	threads,
}: {
	onOpen: (threadId: string) => void;
	threads: InterfaceThread[];
}) {
	const acted = useContext(World2dActed);
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-[132px] flex-1 flex-col gap-2 p-1"
			style={{ ...frameStyle("wood"), ...SV_TEXT }}
		>
			<h3
				className={cn(
					"flex items-baseline justify-between text-[16px] leading-none",
					UI_TYPE
				)}
				id={headingId}
			>
				Past conversations
				{threads.length > 0 ? (
					<span className="text-(--sv-ink-soft) tabular-nums">
						{threads.length}
					</span>
				) : null}
			</h3>
			{threads.length === 0 ? (
				<p
					className={cn(
						"border-(--sv-ink-shadow) border-t-2 pt-2 text-(--sv-ink-soft) text-[16px] leading-6",
						UI_TYPE
					)}
				>
					Nothing yet. Say something below to start your first conversation.
				</p>
			) : (
				<ul className="-mx-1 flex min-h-0 flex-1 flex-col overflow-y-auto border-(--sv-ink-shadow) border-t-2 px-1 pt-1 [scrollbar-color:var(--sv-slot-shade)_transparent] [scrollbar-width:thin]">
					{threads.map((thread) => {
						const status = threadStatus(thread);
						// With acts a thread's legacy status and age would contradict them.
						const marked = !acted && status !== "quiet" && status !== "waiting";
						return (
							<li key={thread.id}>
								<button
									className={cn(
										"group flex h-9 w-full items-center gap-2 border-2 border-transparent pr-2 text-left text-[16px] leading-none outline-none hover:border-(--sv-key-shade) hover:bg-(--sv-parchment-deep) focus-visible:border-(--sv-wood-dark) focus-visible:bg-(--sv-parchment-deep) [ul:not(:hover):not(:focus-within)>li:first-child_&]:border-(--sv-key-shade) [ul:not(:hover):not(:focus-within)>li:first-child_&]:bg-(--sv-parchment-deep)",
										UI_TYPE
									)}
									onClick={() => onOpen(thread.id)}
									type="button"
								>
									<ChoiceGlove />
									<span className="min-w-0 flex-1 truncate">
										{thread.title || "Untitled"}
									</span>
									<span className="flex w-4 shrink-0 justify-center">
										{marked ? (
											<>
												<StatusMark status={status} />
												<span className="sr-only">
													{`, ${villagerStatusLabel(status)}`}
												</span>
											</>
										) : null}
									</span>
									{acted ? null : (
										<span className="w-8 shrink-0 text-right text-(--sv-ink-soft) text-[16px] tabular-nums">
											{compactAge(thread.updatedAt)}
										</span>
									)}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

/**
 * The conversation panel the village opens when the player talks to an
 * agent. The open thread (`threadView`) is the host's own chat, shown in
 * the user's theme inside the dialogue box's wood frame.
 */
export function World2dPanel({
	activeThreadId = null,
	agent,
	lookIndex = -1,
	onClose,
	port,
	status,
	threads,
	threadView,
}: {
	/** The open thread, whose conversation the dialogue box speaks to. */
	activeThreadId?: string | null;
	agent: InterfaceAgent;
	/** The agent's place in the village (picks its portrait's outfit). */
	lookIndex?: number;
	onClose: () => void;
	port: InterfacePort;
	status: VillagerStatus;
	threads: InterfaceThread[];
	threadView: ReactNode | null;
}) {
	const openThread =
		threadView === null
			? null
			: (threads.find((thread) => thread.id === activeThreadId) ?? null);
	return (
		<aside
			aria-label={`Talking to ${agent.name}`}
			className="@container absolute inset-0 z-[500] flex h-full w-full shrink-0 flex-col gap-2 overflow-y-auto overflow-x-hidden border-(--sv-outline) border-l-[3px] p-3 [scrollbar-color:var(--sv-slot-shade)_transparent] [scrollbar-width:thin] sm:static sm:w-[clamp(320px,40%,440px)]"
			data-testid="world-agent-panel"
			style={PANEL_BACKING}
		>
			{/* Above the frames, on the same top inset as the clock: the way
			    back to the list (with a thread open) and Stardew's red close
			    "X" just past the menu's corner. */}
			<div className="flex h-8 shrink-0 items-center justify-between gap-2">
				{threadView ? (
					<button
						aria-label="Back to conversations"
						className={PLANK_BUTTON}
						onClick={port.closeThread}
						style={{ ...frameStyle("plank", 2), ...SV_PLANK_TEXT }}
						type="button"
					>
						<BackIcon />
						Conversations
					</button>
				) : (
					<span />
				)}
				<CloseButton
					keyShortcut="Escape"
					label="Walk away"
					onClick={onClose}
					title="Walk away (Esc)"
				/>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-3">
				<DialogueBox
					agent={agent}
					compact={threadView !== null}
					lookIndex={lookIndex}
					openThread={openThread}
					status={status}
					threads={threads}
				/>
				{threadView ? (
					<div
						className="flex min-h-[240px] flex-1 flex-col"
						style={frameStyle("wood")}
					>
						<div
							className="-m-1 flex min-h-0 flex-1 flex-col overflow-hidden border-2 border-border bg-background text-foreground focus-within:border-ring"
							data-testid="world-2d-thread"
						>
							{threadView}
						</div>
					</div>
				) : (
					<>
						<DialogueChoices onOpen={port.openThread} threads={threads} />
						<ReplyBox
							agent={agent}
							key={agent.id}
							onSubmit={(prompt) =>
								port.startThread({ agentId: agent.id, prompt })
							}
						/>
					</>
				)}
			</div>
		</aside>
	);
}
