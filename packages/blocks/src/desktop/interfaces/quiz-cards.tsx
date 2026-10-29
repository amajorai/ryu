import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { motion, useIsPresent } from "motion/react";
import {
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
	type Ref,
	useId,
	useState,
} from "react";
import { agentById } from "./interface-renderer.ts";
import { QuizAvatar } from "./quiz-avatar.tsx";
import { tileLayoutId } from "./quiz-board.tsx";
import { clueText, type QuizTile, threadTitle } from "./quiz-model.ts";
import { QUIZ_BROADCAST_TYPE, TILE_BEVEL, TILE_FACE } from "./quiz-palette.ts";
import { QuizContestantPicker } from "./quiz-picker.tsx";

const MAX_PROMPT_LENGTH = 8000;

/** One focus mark for everything on the board: a 2px ink ring, offset 2px. */
const ON_BOARD_FOCUS =
	"focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-(--quiz-ink) focus-visible:ring-offset-2 focus-visible:ring-offset-(--quiz-board)";

/** Buttons that sit on the board: white ink on board blue. */
export const ON_BOARD_PRIMARY = cn(
	"gk-display bg-(--quiz-gold) text-(--quiz-frame) shadow-[0_3px_0_var(--quiz-gold-deep),0_0_0_2px_var(--quiz-frame)] hover:bg-(--quiz-gold) hover:brightness-105 active:translate-y-0.5 active:shadow-[0_1px_0_var(--quiz-gold-deep),0_0_0_2px_var(--quiz-frame)] disabled:opacity-50 motion-reduce:active:translate-y-0",
	ON_BOARD_FOCUS
);
export const ON_BOARD_GHOST = cn(
	"gk-display text-(--quiz-ink) hover:bg-(--quiz-ink)/10 hover:text-(--quiz-ink) active:bg-(--quiz-ink)/15 aria-expanded:bg-(--quiz-ink)/10 aria-expanded:text-(--quiz-ink)",
	ON_BOARD_FOCUS
);

/** Board buttons: a touch taller than the stock size, set for a stage. */
const BOARD_BUTTON = "h-11 rounded-xl px-6 text-base";
/** The clue card's two keys: sized to the clue above them. */
const CLUE_BUTTON = "h-12 min-w-36 rounded-xl px-8 text-[18px]";

/** Clue type: the board's serif caps, sized from the board's width. */
const CLUE_TYPE =
	"font-serif text-(--quiz-ink) uppercase text-[clamp(1.25rem,3.2cqw,2.5rem)] leading-[1.2] tracking-[0.02em] text-balance [text-shadow:0_2px_0_var(--quiz-shade)]";

/** The category and value lockup centred above a clue. */
const LOCKUP_TYPE = cn(
	"font-extrabold uppercase leading-none tracking-[0.02em]",
	QUIZ_BROADCAST_TYPE
);

/** A full-board card laid over the tiles: a clue, the final question, or a notice. */
function BoardCard({
	animate,
	children,
	label,
	layoutId,
	onKeyDown,
}: {
	animate: boolean;
	children: ReactNode;
	label: string;
	layoutId?: string;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
}) {
	// While it animates away the card is scenery: not a dialog, not focusable.
	const present = useIsPresent();
	return (
		<motion.div
			animate={{ opacity: 1 }}
			aria-hidden={present ? undefined : true}
			aria-label={present ? label : undefined}
			className="absolute inset-1.5 z-10 flex flex-col rounded-[3px] bg-(--quiz-board) @3xl/board:px-12 px-5 @3xl/board:py-8 py-5"
			exit={{ opacity: animate && layoutId ? 1 : 0 }}
			inert={!present}
			initial={{ opacity: animate && layoutId ? 1 : 0 }}
			layoutId={animate ? layoutId : undefined}
			onKeyDown={onKeyDown}
			role={present ? "dialog" : undefined}
			style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
			transition={{ duration: animate ? 0.32 : 0, ease: [0.2, 0.8, 0.2, 1] }}
		>
			<motion.div
				animate={{ opacity: 1 }}
				className="flex min-h-0 flex-1 flex-col"
				initial={{ opacity: animate ? 0 : 1 }}
				transition={{ delay: animate ? 0.16 : 0, duration: 0.18 }}
			>
				{children}
			</motion.div>
		</motion.div>
	);
}

/** The header on a board card or the booth: the category, and the value. */
export function CardLockup({
	className,
	compact = false,
	title,
	value,
}: {
	className?: string;
	/** The booth's smaller size. */
	compact?: boolean;
	title: string;
	value?: number;
}) {
	const size = compact ? "text-sm" : "text-[clamp(1.125rem,1.8cqw,1.5rem)]";
	return (
		<p
			className={cn(
				"flex min-w-0 max-w-full items-baseline justify-center gap-3",
				className
			)}
		>
			<span
				className={cn(LOCKUP_TYPE, "min-w-0 truncate text-(--quiz-ink)", size)}
			>
				{title}
			</span>
			{value === undefined ? null : (
				<span
					className={cn(
						LOCKUP_TYPE,
						"shrink-0 text-(--quiz-gold) tabular-nums",
						size
					)}
				>
					{value}
				</span>
			)}
		</p>
	);
}

/**
 * The clue: the conversation's latest message read out in board caps, with
 * who said it and where it stands, and the two ways off the card.
 */
export function QuizClueCard({
	animate,
	answerRef,
	onAnswer,
	onBack,
	snapshot,
	tile,
}: {
	animate: boolean;
	answerRef: Ref<HTMLButtonElement>;
	onAnswer: () => void;
	onBack: () => void;
	snapshot: InterfaceSnapshot;
	tile: QuizTile;
}) {
	const tl = useLiteralMessages();
	const agent = agentById(snapshot, tile.agentId);
	const speaker =
		tile.thread.lastMessageRole === "user" ? "You" : (agent?.name ?? "Agent");
	const hasMessage = Boolean(tile.thread.lastMessage?.trim());
	const headingId = useId();
	return (
		<BoardCard
			animate={animate}
			label={tl("{categoryName} for {value}", {
				categoryName: tile.categoryName,
				value: String(tile.value),
			})}
			layoutId={tileLayoutId(tile.thread.id)}
		>
			{/* my-auto centres the clue but lets a long one scroll from its top. */}
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
				<div className="my-auto flex flex-col items-center py-2">
					<CardLockup title={tile.categoryName} value={tile.value} />
					<h2
						className={cn(
							"mt-6 line-clamp-6 max-w-[36ch] text-center",
							CLUE_TYPE
						)}
						id={headingId}
					>
						{clueText(tile.thread)}
					</h2>
					{/* Clue, then context and actions as one group: the meta line sits
					    nearer the keys than the clue. */}
					<div className="mt-8 flex min-w-0 max-w-full items-center gap-2 text-(--quiz-ink-muted) text-[15px]">
						{agent ? <QuizAvatar agent={agent} className="size-6" /> : null}
						<span className="truncate">
							{hasMessage ? `${speaker} in ` : ""}
							<span className="font-semibold text-(--quiz-ink)">
								{threadTitle(tile.thread)}
							</span>
						</span>
						<span aria-hidden="true">·</span>
						<span className="shrink-0">
							{THREAD_STATUS_LABELS[tile.status]}
						</span>
					</div>
					<div className="mt-6 flex flex-wrap items-center justify-center gap-3">
						<Button
							className={cn(ON_BOARD_PRIMARY, CLUE_BUTTON)}
							onClick={onAnswer}
							ref={answerRef}
							type="button"
						>
							Answer
						</Button>
						<Button
							aria-keyshortcuts="Escape"
							className={cn(ON_BOARD_GHOST, CLUE_BUTTON)}
							onClick={onBack}
							type="button"
							variant="ghost"
						>
							Back to board
						</Button>
					</div>
				</div>
			</div>
		</BoardCard>
	);
}

/**
 * Final question: the user writes a prompt and picks the contestant who
 * answers it. Submitting is the explicit action that lets the host send it.
 */
export function QuizFinalQuestion({
	agents,
	animate,
	defaultAgentId,
	featuredIds,
	fieldRef,
	onCancel,
	onSubmit,
}: {
	agents: InterfaceAgent[];
	animate: boolean;
	defaultAgentId: string | undefined;
	/** The podium contestants, offered first in the picker. */
	featuredIds: string[];
	fieldRef: Ref<HTMLTextAreaElement>;
	onCancel: () => void;
	onSubmit: (input: { agentId?: string; prompt: string }) => void;
}) {
	const tl = useLiteralMessages();
	const fieldId = useId();
	const titleId = useId();
	const [prompt, setPrompt] = useState("");
	const [picked, setPicked] = useState(defaultAgentId);
	const agentId = agents.some((agent) => agent.id === picked)
		? picked
		: agents[0]?.id;
	const agent = agents.find((candidate) => candidate.id === agentId);
	const trimmed = prompt.trim();

	const submit = () => {
		if (trimmed) {
			onSubmit({ agentId, prompt: trimmed });
		}
	};
	const onFormSubmit = (event: FormEvent) => {
		event.preventDefault();
		submit();
	};
	const onFieldKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
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
		<BoardCard animate={animate} label="Final question">
			<form
				aria-labelledby={titleId}
				className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 overflow-y-auto"
				onSubmit={onFormSubmit}
			>
				<h2 className="max-w-full text-balance text-center" id={titleId}>
					<span className={cn(CLUE_TYPE, "text-[clamp(1.25rem,2.6cqw,2rem)]")}>
						{agent
							? tl("Final question for {agentName}", { agentName: agent.name })
							: "Final question"}
					</span>
				</h2>
				<QuizContestantPicker
					agents={agents}
					featuredIds={featuredIds}
					onPick={setPicked}
					pickedId={agentId}
				/>
				<label className="sr-only" htmlFor={fieldId}>
					{agent
						? tl("Question for {agentName}", { agentName: agent.name })
						: "Your question"}
				</label>
				<textarea
					className="field-sizing-content max-h-48 min-h-28 w-full resize-none rounded-md border border-(--quiz-ink)/25 bg-(--quiz-frame)/35 px-4 py-3 text-(--quiz-ink) text-base leading-relaxed outline-none transition-colors placeholder:text-(--quiz-ink-faint) focus-visible:border-(--quiz-ink)/70 motion-reduce:transition-none"
					id={fieldId}
					maxLength={MAX_PROMPT_LENGTH}
					onChange={(event) => setPrompt(event.target.value)}
					onKeyDown={onFieldKeyDown}
					placeholder="Write the question you want answered"
					ref={fieldRef}
					value={prompt}
				/>
				<div className="flex flex-wrap items-center justify-center gap-3">
					<Button
						className={cn(ON_BOARD_PRIMARY, BOARD_BUTTON, "min-w-32")}
						disabled={!trimmed}
						type="submit"
					>
						{agent
							? tl("Send to {agentName}", { agentName: agent.name })
							: "Send"}
					</Button>
					<Button
						aria-keyshortcuts="Escape"
						className={cn(ON_BOARD_GHOST, BOARD_BUTTON)}
						onClick={onCancel}
						type="button"
						variant="ghost"
					>
						Back to board
					</Button>
				</div>
			</form>
		</BoardCard>
	);
}

/** What the board says when there is nothing to play. */
export function QuizEmptyCard({
	hasAgents,
	onStart,
}: {
	hasAgents: boolean;
	onStart: () => void;
}) {
	return (
		<div
			className="absolute inset-1.5 z-10 flex flex-col items-center justify-center gap-5 rounded-[3px] bg-(--quiz-board) px-6 text-center"
			style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
		>
			<h2 className={cn("max-w-[28ch]", CLUE_TYPE)}>
				{hasAgents
					? "No conversations on the board yet"
					: "No contestants and no conversations yet"}
			</h2>
			<p className="max-w-md text-(--quiz-ink-muted) text-[15px] leading-relaxed">
				Each conversation becomes a clue, filed under its project, team, or
				agent. Start one and it takes its place on the board.
			</p>
			<Button
				className={cn(ON_BOARD_PRIMARY, BOARD_BUTTON)}
				onClick={onStart}
				type="button"
			>
				Start a conversation
			</Button>
		</div>
	);
}
