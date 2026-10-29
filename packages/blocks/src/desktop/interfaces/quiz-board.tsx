import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
	CATEGORY_KIND_LABELS,
	type QuizBoard,
	type QuizCategory,
	type QuizTile,
	rowValue,
	threadTitle,
} from "./quiz-model.ts";
import {
	BOARD_BEZEL,
	BROADCAST_FIGURES,
	IN_PLAY_EDGE,
	LIT_EDGE,
	NARROW_FIGURES,
	PLAYED_BEVEL,
	QUIZ_BROADCAST_TYPE,
	TILE_BEVEL,
	TILE_FACE,
} from "./quiz-palette.ts";

export const TILE_ATTRIBUTE = "data-quiz-tile";

/** Shared-layout id that lets a tile grow into its clue card. */
export function tileLayoutId(threadId: string): string {
	return `quiz-tile-${threadId}`;
}

/**
 * The board is a fixed six by five grid that the studio sizes to its space.
 * Type reads the board's size (`cqw`/`cqh`), so values and categories keep
 * their place in any cell. Below 32rem the board folds into two bands of
 * three categories and the stage scrolls, so cells keep a fixed landscape
 * shape there.
 */
const VALUE_TYPE =
	"text-[clamp(1.75rem,min(5cqw,9.5cqh),4.75rem)] @max-[32rem]/board:text-[clamp(1.75rem,10cqw,2.5rem)]";
const CATEGORY_TYPE =
	"text-[clamp(0.875rem,min(1.75cqw,3.8cqh),1.625rem)] @max-[32rem]/board:text-[clamp(0.8125rem,3.8cqw,1rem)]";
const HEAD_SIZE =
	"h-[clamp(3.5rem,min(6.5cqw,14cqh),6rem)] @max-[32rem]/board:h-16";
const CELL_SIZE =
	"min-h-10 flex-1 basis-0 @max-[32rem]/board:h-18 @max-[32rem]/board:flex-none";
/** What a tile's caption says, for the states that ask for a look. */
const STATUS_CAPTION: Partial<Record<QuizTile["status"], string>> = {
	attention: "Needs you",
	"your-turn": "Your turn",
	working: "Working",
};

const WORKING_DOTS = ["0ms", "200ms", "400ms"];

/** Three ink dots under the value, like a typing indicator: the conversation is working. */
function WorkingDots() {
	return (
		<span aria-hidden="true" className="flex justify-center gap-1.5">
			{WORKING_DOTS.map((delay) => (
				<span
					className="size-1.5 rounded-full bg-(--quiz-ink) motion-safe:animate-pulse"
					key={delay}
					style={{ animationDelay: delay }}
				/>
			))}
		</span>
	);
}

/**
 * The board: a dark bezel with a lit rim, the black seams between cells,
 * the category row, and five rows of tiles per column. `children` (a clue,
 * the final question, or the empty message) is laid over the whole board.
 */
export function QuizBoardFrame({
	busy,
	children,
	className,
	label,
	cells,
	rows,
	style,
}: {
	busy?: boolean;
	cells: ReactNode;
	children?: ReactNode;
	className?: string;
	label: string;
	/** Rows of tiles under the category row. */
	rows: number;
	style?: CSSProperties;
}) {
	return (
		<section
			aria-busy={busy || undefined}
			aria-label={label}
			className={cn(
				"relative flex min-w-0 rounded-[10px] bg-(--quiz-frame) p-1.5 [container:board/size]",
				className
			)}
			style={
				{
					...style,
					"--quiz-rows": rows,
					boxShadow: BOARD_BEZEL,
				} as CSSProperties
			}
		>
			<div className="grid min-h-0 flex-1 @max-[32rem]/board:grid-cols-3 grid-cols-6 @max-[32rem]/board:grid-rows-none grid-rows-[minmax(0,1fr)] gap-1.5 @max-[32rem]/board:gap-y-5">
				{cells}
			</div>
			{children}
		</section>
	);
}

function CategoryHead({
	category,
	id,
}: {
	category: QuizCategory | null;
	id: string;
}) {
	if (!category) {
		return (
			<div
				aria-hidden="true"
				className={cn(
					"mb-1.5 shrink-0 rounded-[3px] bg-(--quiz-off)",
					HEAD_SIZE
				)}
				style={{ boxShadow: PLAYED_BEVEL }}
			/>
		);
	}
	return (
		<h3
			className={cn(
				"mb-1.5 flex shrink-0 items-center justify-center rounded-[3px] px-2 text-center",
				HEAD_SIZE
			)}
			id={id}
			style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
		>
			{/* The game kit's display face, the same as the HUD's names. */}
			<span
				className={cn(
					"gk-display line-clamp-2 text-balance text-(--quiz-ink) uppercase tracking-[0.03em] [text-shadow:var(--quiz-category-shadow)]",
					CATEGORY_TYPE,
					"leading-[1.08]"
				)}
			>
				{category.name}
			</span>
			<span className="sr-only">, {CATEGORY_KIND_LABELS[category.kind]}</span>
		</h3>
	);
}

/**
 * A cell with no clue showing: the slot under the open clue card keeps the
 * board's blue; a cheap slot above a short column is a blank square, the
 * same as a played one, as on the show mid-game.
 */
function BlankCell({ value }: { value?: number }) {
	const played = value !== undefined;
	return (
		<li
			aria-hidden="true"
			className={cn(
				"flex items-center justify-center rounded-[3px]",
				CELL_SIZE,
				played ? "bg-(--quiz-played)" : "bg-(--quiz-board)"
			)}
			style={
				played
					? { boxShadow: PLAYED_BEVEL }
					: { backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }
			}
		>
			{played ? <PlayedValue value={value} /> : null}
		</li>
	);
}

/** A played slot keeps its value, dimmed into the board like a spent lamp. */
function PlayedValue({ value }: { value: number }) {
	return (
		<span
			className={cn(
				"font-black text-(--quiz-ink) leading-none opacity-[0.09]",
				BROADCAST_FIGURES,
				NARROW_FIGURES,
				QUIZ_BROADCAST_TYPE,
				VALUE_TYPE
			)}
		>
			{value}
		</span>
	);
}

/**
 * What a tile shows: its value (gold when it needs the user), nothing once
 * played (the title surfaces on hover or focus), or "Answering" while its
 * conversation is open in the booth.
 */
function TileFace({
	inPlay,
	lit,
	played,
	tile,
	working,
}: {
	inPlay: boolean;
	lit: boolean;
	played: boolean;
	tile: QuizTile;
	working: boolean;
}) {
	if (inPlay) {
		return (
			<span
				className={cn(
					"max-w-full truncate font-bold text-(--quiz-gold) text-[clamp(0.6875rem,1.3cqw,0.875rem)] uppercase leading-none tracking-[0.06em]",
					QUIZ_BROADCAST_TYPE
				)}
			>
				Answering
			</span>
		);
	}
	if (played) {
		return (
			<>
				<span className="transition-opacity duration-150 group-hover/tile:opacity-0 group-focus-visible/tile:opacity-0 motion-reduce:transition-none">
					<PlayedValue value={tile.value} />
				</span>
				<span
					className={cn(
						"absolute inset-x-3 line-clamp-2 text-center font-semibold text-(--quiz-ink-muted) text-[13px] leading-snug transition-opacity duration-150 motion-reduce:transition-none",
						"opacity-0 group-hover/tile:opacity-100 group-focus-visible/tile:opacity-100"
					)}
				>
					{threadTitle(tile.thread)}
				</span>
			</>
		);
	}
	// The value, then a caption for the states that ask for a look; the
	// caption sits under the value so the value stays centred on the tile.
	const caption = STATUS_CAPTION[tile.status];
	return (
		<>
			<span
				className={cn(
					"font-black text-(--quiz-gold) [text-shadow:var(--quiz-value-shadow)]",
					BROADCAST_FIGURES,
					NARROW_FIGURES,
					QUIZ_BROADCAST_TYPE,
					VALUE_TYPE,
					"leading-none"
				)}
			>
				{tile.value}
			</span>
			{caption ? (
				<span
					className={cn(
						"absolute inset-x-1 bottom-[9%] flex items-center justify-center gap-1.5 truncate whitespace-nowrap font-bold text-[clamp(0.6875rem,1.05cqw,0.875rem)] uppercase leading-none tracking-[0.08em]",
						lit ? "text-(--quiz-lit-edge)" : "text-(--quiz-ink-muted)",
						QUIZ_BROADCAST_TYPE
					)}
				>
					{working ? <WorkingDots /> : null}
					{caption}
				</span>
			) : null}
		</>
	);
}

export interface TileHandlers {
	/**
	 * Name tiles clue first ("500 clue, Bo: …"), so with the act layer no
	 * tile reads like an agent's own target ("Bo for 500: …").
	 */
	clueFirst?: boolean;
	onFocusTile: (threadId: string) => void;
	onKeyDown: (
		event: KeyboardEvent<HTMLButtonElement>,
		threadId: string
	) => void;
	onPick: (threadId: string) => void;
}

/** A tile's accessible name, by whether it is open, revealed or answering. */
export function tileLabel(
	tile: QuizTile,
	state: "answering" | "open" | "revealed",
	clueFirst = false
): string {
	const title = threadTitle(tile.thread);
	const status = tile.statusWord ?? THREAD_STATUS_LABELS[tile.status];
	if (clueFirst) {
		const clue = state === "open" ? `${tile.value} clue` : `Clue ${state}`;
		return `${clue}, ${tile.categoryName}: ${title}. ${status}.`;
	}
	if (state === "open") {
		return `${tile.categoryName} for ${tile.value}: ${title}. ${status}.`;
	}
	return `${tile.categoryName}, ${state}: ${title}. ${status}.`;
}

function tileState(
	inPlay: boolean,
	revealed: boolean
): "answering" | "open" | "revealed" {
	if (inPlay) {
		return "answering";
	}
	return revealed ? "revealed" : "open";
}

function BoardTile({
	animate,
	handlers,
	inPlay,
	open,
	revealed,
	tabbable,
	tile,
}: {
	animate: boolean;
	handlers: TileHandlers;
	/** The conversation is open in the answer booth. */
	inPlay: boolean;
	/** The clue for this tile is showing (the tile has grown into it). */
	open: boolean;
	revealed: boolean;
	tabbable: boolean;
	tile: QuizTile;
}) {
	const id = tile.thread.id;
	if (open) {
		// The tile is the clue card right now; keep its cell as a blank.
		return <BlankCell />;
	}
	// A clue being answered is off the board, like any revealed one.
	const played = revealed || inPlay;
	const lit = tile.needsYou && !played;
	const working = tile.status === "working" && !played;
	let edge = TILE_BEVEL;
	if (inPlay) {
		edge = `${IN_PLAY_EDGE}, ${TILE_BEVEL}`;
	} else if (lit) {
		edge = `${LIT_EDGE}, ${TILE_BEVEL}`;
	}
	// A played square is pressed into the board, like the cheap slots above.
	const pressed = revealed && !inPlay;
	if (pressed) {
		edge = PLAYED_BEVEL;
	}
	const tone = pressed ? "bg-(--quiz-played)" : "bg-(--quiz-board)";
	const title = `${threadTitle(tile.thread)} \u00b7 ${tile.statusWord ?? THREAD_STATUS_LABELS[tile.status]}`;
	return (
		<li className={cn("flex", CELL_SIZE)}>
			<motion.button
				aria-current={inPlay ? "true" : undefined}
				aria-label={tileLabel(
					tile,
					tileState(inPlay, revealed),
					handlers.clueFirst
				)}
				className={cn(
					"group/tile relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center rounded-[3px] px-3 outline-none transition-[filter] duration-150 hover:brightness-115 motion-reduce:transition-none",
					tone,
					// Focus is its own mark in the gap around the tile, so the lit
					// and in-play edges inside it always stay visible.
					"focus-visible:outline-(--quiz-ink) focus-visible:outline-[3px] focus-visible:outline-solid focus-visible:outline-offset-[1.5px]"
				)}
				data-thread-id={id}
				layoutId={animate ? tileLayoutId(id) : undefined}
				onClick={() => handlers.onPick(id)}
				onFocus={() => handlers.onFocusTile(id)}
				onKeyDown={(event) => handlers.onKeyDown(event, id)}
				style={{
					backgroundImage: pressed ? undefined : TILE_FACE,
					boxShadow: edge,
				}}
				tabIndex={tabbable ? 0 : -1}
				title={played ? undefined : title}
				type="button"
				{...{ [TILE_ATTRIBUTE]: "" }}
			>
				<TileFace
					inPlay={inPlay}
					lit={lit}
					played={played}
					tile={tile}
					working={working}
				/>
			</motion.button>
		</li>
	);
}

/** One category: its head, the played cheap slots, then its tiles. */
function BoardColumn({
	animate,
	category,
	double,
	handlers,
	inPlayId,
	index,
	isRevealed,
	openId,
	rows,
	tabStopId,
}: {
	animate: boolean;
	category: QuizCategory | null;
	double: boolean;
	handlers: TileHandlers;
	inPlayId: string | null;
	index: number;
	isRevealed: (tile: QuizTile) => boolean;
	openId: string | null;
	rows: number;
	tabStopId: string | null;
}) {
	const headId = `quiz-category-${index}`;
	const tiles = category?.tiles ?? [];
	const undealt = Array.from(
		{ length: Math.max(0, rows - tiles.length) },
		(_, slot) => ({ key: `undealt-${slot}`, value: rowValue(slot, double) })
	);
	return (
		<div className="flex min-h-0 min-w-0 snap-start scroll-ms-1.5 flex-col gap-1.5">
			<CategoryHead category={category} id={headId} />
			<ul
				aria-hidden={category ? undefined : true}
				aria-labelledby={category ? headId : undefined}
				className="flex min-h-0 flex-1 flex-col gap-1.5"
			>
				{undealt.map((slot) => (
					<BlankCell key={slot.key} value={slot.value} />
				))}
				{tiles.map((tile) => (
					<BoardTile
						animate={animate}
						handlers={handlers}
						inPlay={inPlayId === tile.thread.id}
						key={tile.thread.id}
						open={openId === tile.thread.id}
						revealed={isRevealed(tile)}
						tabbable={tabStopId === tile.thread.id}
						tile={tile}
					/>
				))}
			</ul>
		</div>
	);
}

export function QuizBoardCells({
	animate,
	board,
	handlers,
	inPlayId,
	isRevealed,
	openId,
	tabStopId,
}: {
	animate: boolean;
	board: QuizBoard;
	handlers: TileHandlers;
	inPlayId: string | null;
	isRevealed: (tile: QuizTile) => boolean;
	openId: string | null;
	tabStopId: string | null;
}) {
	return board.columns.map((category, index) => (
		<BoardColumn
			animate={animate}
			category={category}
			double={board.double}
			handlers={handlers}
			index={index}
			inPlayId={inPlayId}
			isRevealed={isRevealed}
			key={category?.id ?? `empty-${index}`}
			openId={openId}
			rows={board.rows}
			tabStopId={tabStopId}
		/>
	));
}

const SKELETON_COLUMNS = ["c0", "c1", "c2", "c3", "c4", "c5"];
const SKELETON_ROWS = ["r0", "r1", "r2", "r3", "r4"];

/** The board while the first snapshot loads: unlit cells, a soft pulse. */
export function QuizBoardSkeleton() {
	return SKELETON_COLUMNS.map((column) => (
		<div className="flex min-h-0 min-w-0 flex-col gap-1.5" key={column}>
			<div
				className={cn(
					"mb-1.5 flex shrink-0 items-center justify-center rounded-[3px]",
					HEAD_SIZE
				)}
				style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
			>
				<span className="h-2.5 w-3/5 rounded-full bg-(--quiz-lamp-off) motion-safe:animate-pulse" />
			</div>
			{SKELETON_ROWS.map((row) => (
				<div
					className={cn(
						"flex items-center justify-center rounded-[3px]",
						CELL_SIZE
					)}
					key={row}
					style={{ backgroundImage: TILE_FACE, boxShadow: TILE_BEVEL }}
				>
					<span className="h-5 w-1/3 rounded-sm bg-(--quiz-lamp-off) motion-safe:animate-pulse" />
				</div>
			))}
		</div>
	));
}

/** Scroll a tile into view (the folded board scrolls) without moving focus. */
export function revealTile(container: HTMLElement | null, threadId: string) {
	container
		?.querySelector<HTMLElement>(
			`[${TILE_ATTRIBUTE}][data-thread-id="${CSS.escape(threadId)}"]`
		)
		?.scrollIntoView({ block: "nearest" });
}

/** Focus a tile by thread id inside the board (used for arrow keys and returns). */
export function focusTile(
	container: HTMLElement | null,
	threadId: string
): boolean {
	const tile = container?.querySelector<HTMLElement>(
		`[${TILE_ATTRIBUTE}][data-thread-id="${CSS.escape(threadId)}"]`
	);
	tile?.focus();
	return Boolean(tile);
}
