import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import type { PassportSpread } from "./passport-model.ts";
import { PAGE_HEIGHT, PAGE_WIDTH } from "./passport-pages.tsx";
import { BOOKLET_SHADOW, TURN_SHADE } from "./passport-palette.ts";

/** Board that shows around the pages, in booklet px. */
export const BOARD = 7;
/** Room on the right for the index tabs. */
export const TAB_ROOM = 34;
const TURN_EASE = [0.45, 0, 0.2, 1] as const;
export const TURN_SECONDS = 0.68;
/** Below this scale the microprint drops under ~4px: pages leave it out. */
const FINE_PRINT_FROM = 0.8;

export interface PageTurn {
	from: number;
	to: number;
}

export interface BookTab {
	active: boolean;
	code: string;
	/** The identity tab prints in the cover's foil, not a country's ink. */
	foil?: boolean;
	ink: string;
	label: string;
	onSelect: () => void;
}

function tabColors(tab: BookTab): CSSProperties {
	if (tab.foil) {
		return {
			background: tab.active
				? "var(--pp-cover)"
				: "color-mix(in oklab, var(--pp-cover) 10%, var(--pp-paper))",
			boxShadow: tab.active
				? "inset 0 0 0 1px color-mix(in oklab, var(--pp-foil) 55%, transparent)"
				: undefined,
			color: tab.active ? "var(--pp-foil)" : "var(--pp-ink)",
		};
	}
	return {
		background: tab.active
			? tab.ink
			: `color-mix(in oklab, ${tab.ink} 16%, var(--pp-paper))`,
		color: tab.active ? "var(--pp-paper)" : tab.ink,
	};
}

/** Index tabs on the fore-edge, one per country, coloured with its ink. */
function IndexTabs({ tabs }: { tabs: BookTab[] }) {
	return (
		<nav
			aria-label="Index tabs"
			className="absolute top-6 flex flex-col gap-1"
			style={{ insetInlineStart: "100%" }}
		>
			{tabs.map((tab) => (
				<button
					aria-current={tab.active ? "page" : undefined}
					aria-label={tab.label}
					className={cn(
						"flex h-10 w-[30px] cursor-pointer items-center justify-center rounded-e-[5px] font-mono font-semibold text-[9.5px] tracking-[0.06em] outline-none transition-transform duration-150 [writing-mode:vertical-rl] focus-visible:ring-2 focus-visible:ring-ring",
						tab.active ? "translate-x-0" : "-translate-x-1 hover:translate-x-0"
					)}
					key={tab.code}
					onClick={tab.onSelect}
					style={tabColors(tab)}
					title={tab.label}
					type="button"
				>
					{tab.code}
				</button>
			))}
		</nav>
	);
}

function PageSlot({
	children,
	side,
}: {
	children: ReactNode;
	side: "left" | "right";
}) {
	return (
		<div
			className="absolute top-0 overflow-hidden"
			style={{
				height: PAGE_HEIGHT,
				left: side === "left" ? 0 : PAGE_WIDTH,
				width: PAGE_WIDTH,
			}}
		>
			{children}
		</div>
	);
}

/**
 * The leaf that turns: its front is the page being lifted, its back the page
 * it reveals. Forward turns hinge on the spine from the right half; backward
 * turns from the left half.
 */
function TurningLeaf({
	back,
	direction,
	front,
	onDone,
}: {
	back: ReactNode;
	direction: 1 | -1;
	front: ReactNode;
	onDone: () => void;
}) {
	const forward = direction === 1;
	return (
		<motion.div
			animate={{ rotateY: forward ? -180 : 180 }}
			className="absolute top-0 z-20"
			initial={{ rotateY: 0 }}
			onAnimationComplete={onDone}
			style={{
				height: PAGE_HEIGHT,
				left: forward ? PAGE_WIDTH : 0,
				transformOrigin: forward ? "left center" : "right center",
				transformStyle: "preserve-3d",
				width: PAGE_WIDTH,
			}}
			transition={{ duration: TURN_SECONDS, ease: TURN_EASE }}
		>
			<div
				className="absolute inset-0 overflow-hidden"
				style={{ backfaceVisibility: "hidden" }}
			>
				{front}
				<motion.div
					animate={{ opacity: [0, 1, 1] }}
					className="pointer-events-none absolute inset-0"
					style={{ background: TURN_SHADE }}
					transition={{ duration: TURN_SECONDS, times: [0, 0.5, 1] }}
				/>
			</div>
			<div
				className="absolute inset-0 overflow-hidden"
				style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
			>
				{back}
				<motion.div
					animate={{ opacity: [1, 1, 0] }}
					className="pointer-events-none absolute inset-0"
					style={{ background: TURN_SHADE }}
					transition={{ duration: TURN_SECONDS, times: [0, 0.5, 1] }}
				/>
			</div>
		</motion.div>
	);
}

/**
 * The open booklet. It renders at a fixed size and scales as a whole, so the
 * stamps keep their proportions at any window size. `turn` drives the leaf;
 * with reduced motion (or a single page) the views crossfade instead.
 */
export function Booklet({
	onTurnDone,
	renderPage,
	scale,
	single,
	smooth,
	spreads,
	tabs,
	turn,
	view,
}: {
	onTurnDone: () => void;
	renderPage: (page: number, side: "left" | "right" | "single") => ReactNode;
	scale: number;
	single: boolean;
	/** False with reduced motion: crossfade, never turn. */
	smooth: boolean;
	spreads: PassportSpread[];
	tabs: BookTab[];
	turn: PageTurn | null;
	view: number;
}) {
	const width = (single ? PAGE_WIDTH : PAGE_WIDTH * 2) + BOARD * 2;
	const height = PAGE_HEIGHT + BOARD * 2;
	const outerWidth = (width + TAB_ROOM) * scale;

	const current = spreads[view] ?? spreads[0];
	const from = turn ? spreads[turn.from] : undefined;
	const to = turn ? spreads[turn.to] : undefined;
	const direction: 1 | -1 = turn && turn.to < turn.from ? -1 : 1;

	let left: number | null = current?.left ?? null;
	let right: number | null = current?.right ?? null;
	let leaf: ReactNode = null;
	if (turn && from && to && !single) {
		if (direction === 1) {
			left = from.left;
			right = to.right;
			leaf = (
				<TurningLeaf
					back={to.left === null ? null : renderPage(to.left, "left")}
					direction={1}
					front={from.right === null ? null : renderPage(from.right, "right")}
					key={`${turn.from}-${turn.to}`}
					onDone={onTurnDone}
				/>
			);
		} else {
			left = to.left;
			right = from.right;
			leaf = (
				<TurningLeaf
					back={to.right === null ? null : renderPage(to.right, "right")}
					direction={-1}
					front={from.left === null ? null : renderPage(from.left, "left")}
					key={`${turn.from}-${turn.to}`}
					onDone={onTurnDone}
				/>
			);
		}
	}

	// The closed booklet sits centred: shift it left by half a page.
	const target = turn && to ? to : current;
	const closed = !single && target?.left === null;
	const leftBoard = !single && (left !== null || (turn && to?.left !== null));

	if (single) {
		const page = current?.right ?? 0;
		return (
			<div
				className="group/booklet relative shrink-0"
				data-fine={scale >= FINE_PRINT_FROM}
				style={{ height: height * scale, width: outerWidth }}
			>
				<div
					className="absolute top-0 left-0 origin-top-left"
					style={{ height, transform: `scale(${scale})`, width }}
				>
					<div
						className="absolute inset-0 rounded-[10px] bg-(--pp-cover)"
						style={{ boxShadow: BOOKLET_SHADOW }}
					/>
					<div
						className="absolute overflow-hidden rounded-[3px]"
						style={{
							height: PAGE_HEIGHT,
							left: BOARD,
							top: BOARD,
							width: PAGE_WIDTH,
						}}
					>
						<AnimatePresence initial={false} mode="popLayout">
							<motion.div
								animate={{ opacity: 1 }}
								className="absolute inset-0"
								exit={{ opacity: 0 }}
								initial={{ opacity: 0 }}
								key={page}
								transition={{ duration: smooth ? 0.22 : 0.12 }}
							>
								{renderPage(page, "single")}
							</motion.div>
						</AnimatePresence>
					</div>
					<div className="absolute top-0 right-0 h-full" style={{ width: 0 }}>
						<IndexTabs tabs={tabs} />
					</div>
				</div>
			</div>
		);
	}

	return (
		<div
			className="group/booklet relative shrink-0"
			data-fine={scale >= FINE_PRINT_FROM}
			style={{ height: height * scale, width: outerWidth }}
		>
			<div
				className="absolute top-0 left-0 origin-top-left"
				style={{ height, transform: `scale(${scale})`, width }}
			>
				<motion.div
					animate={{ x: closed ? -PAGE_WIDTH / 2 : 0 }}
					className="absolute inset-0"
					initial={false}
					transition={
						smooth
							? { duration: TURN_SECONDS, ease: TURN_EASE }
							: { duration: 0 }
					}
				>
					{/* Boards: the right one always, the left once the cover opens. */}
					<div
						className="absolute top-0 rounded-e-[10px] bg-(--pp-cover)"
						style={{
							boxShadow: BOOKLET_SHADOW,
							height,
							left: PAGE_WIDTH + BOARD,
							width: PAGE_WIDTH + BOARD,
						}}
					/>
					<motion.div
						animate={{ opacity: leftBoard ? 1 : 0 }}
						className="absolute top-0 left-0 rounded-s-[10px] bg-(--pp-cover)"
						initial={false}
						style={{
							boxShadow: BOOKLET_SHADOW,
							height,
							width: PAGE_WIDTH + BOARD,
						}}
						transition={{ duration: smooth ? 0.2 : 0 }}
					/>
					<div
						className="absolute"
						style={{
							height: PAGE_HEIGHT,
							left: BOARD,
							perspective: 3600,
							top: BOARD,
							width: PAGE_WIDTH * 2,
						}}
					>
						{smooth ? (
							<>
								{left === null ? null : (
									<PageSlot side="left">{renderPage(left, "left")}</PageSlot>
								)}
								{right === null ? null : (
									<PageSlot side="right">{renderPage(right, "right")}</PageSlot>
								)}
								{leaf}
							</>
						) : (
							<AnimatePresence initial={false} mode="popLayout">
								<motion.div
									animate={{ opacity: 1 }}
									className="absolute inset-0"
									exit={{ opacity: 0 }}
									initial={{ opacity: 0 }}
									key={view}
									transition={{ duration: 0.16 }}
								>
									{left === null ? null : (
										<PageSlot side="left">{renderPage(left, "left")}</PageSlot>
									)}
									{right === null ? null : (
										<PageSlot side="right">
											{renderPage(right, "right")}
										</PageSlot>
									)}
								</motion.div>
							</AnimatePresence>
						)}
						{/* The spine fold, over both pages. */}
						{left === null ? null : (
							<div
								aria-hidden="true"
								className="pointer-events-none absolute top-0 z-10 h-full w-px bg-(--pp-rule)"
								style={{ left: PAGE_WIDTH }}
							/>
						)}
					</div>
					<div
						className="absolute top-0 h-full"
						style={{ left: width, width: 0 }}
					>
						<IndexTabs tabs={tabs} />
					</div>
				</motion.div>
			</div>
		</div>
	);
}
