import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import type { SeatTone } from "./card-table-model.ts";
import { SeatAvatar, SuitGlyph } from "./card-table-pieces.tsx";
import { useThreadReading } from "./card-table-rows.tsx";
import { GAME_FOCUS, GameIconButton } from "./game-hud.tsx";
import { GAME_SHEET_FULL_BELOW, gameSheetCover } from "./game-shell.tsx";
import { agentById } from "./interface-renderer.ts";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * The drawer's width beside the table: the game kit's side sheet (440px) and
 * the gap it keeps from the edges.
 */
export function drawerWidth(rootWidth: number): number {
	return gameSheetCover(rootWidth);
}

/** Below this the drawer covers the table instead of sitting beside it. */
export const DRAWER_OVERLAY_BELOW = GAME_SHEET_FULL_BELOW;

const DRAWER_SPRING = {
	damping: 38,
	mass: 0.9,
	stiffness: 320,
	type: "spring",
} as const;

/**
 * The open thread, in a drawer at the right of the table: who it is with, its
 * title and status, a close control, and the host's real conversation surface.
 * Beside the table, the drawer's track grows from nothing to its width, so the
 * table shrinks in step with it instead of jumping; on a narrow window it
 * slides over the table instead, at the full width of the interface. Until
 * the interface is measured (`instant`), size changes jump instead of
 * springing, so a page that loads with a thread open never squeezes the table.
 */
/** The open thread's status, as its card and rows read it (acts or not). */
function DrawerStatus({
	now,
	thread,
}: {
	now: number;
	thread: InterfaceThread;
}) {
	const { label, status } = useThreadReading(thread, now);
	return (
		<>
			<span aria-hidden="true">·</span>
			<span
				className={cn(
					"inline-flex shrink-0 items-center gap-1",
					status === "attention" && "text-status-destructive",
					status === "working" && "text-status-success"
				)}
			>
				<SuitGlyph status={status} />
				{label}
			</span>
		</>
	);
}

export function CardTableDrawer({
	actTone,
	instant,
	now,
	onClose,
	overlay,
	snapshot,
	thread,
	threadView,
	width,
}: {
	/**
	 * With the act layer: the lead agent's ring from its act (`actSeatTone`),
	 * with no lap from `updatedAt`.
	 */
	actTone?: SeatTone;
	instant: boolean;
	now: number;
	onClose: () => void;
	overlay: boolean;
	snapshot: InterfaceSnapshot;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
	width: number;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	// Only the drawer's first entrance slides; switching between beside and
	// over the table later swaps the frame in place.
	const [entered, setEntered] = useState(false);
	useEffect(() => setEntered(true), []);
	// Both modes set both properties, so neither inherits the other's width.
	const closed = overlay ? { width: "100%", x: "100%" } : { width: 0, x: 0 };
	const shown = overlay ? { width: "100%", x: 0 } : { width, x: 0 };
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = agentById(snapshot, thread?.agentIds[0]);
	const others = (thread?.agentIds.length ?? 0) - 1;
	return (
		<motion.div
			animate={shown}
			className={cn(
				"relative h-full shrink-0 overflow-hidden",
				overlay && "absolute inset-y-0 right-0 z-40 w-full"
			)}
			data-card-table-drawer=""
			exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : closed}
			initial={reduceMotion || entered ? false : closed}
			// A frame that switches from beside the table to over it is a new
			// element: an animated pixel width never carries over and leaves the
			// overlay hanging off the left edge.
			key={overlay ? "over" : "beside"}
			transition={reduceMotion || instant ? { duration: 0 } : DRAWER_SPRING}
		>
			<aside
				aria-label={tl("Thread: {title}", { title })}
				className="absolute inset-y-0 left-0 flex min-h-0 flex-col p-2 sm:p-3"
				data-testid="card-table-drawer"
				style={overlay ? { width: "100%" } : { width }}
			>
				<div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[22px] border-(--gk-edge) border-2 bg-(--gk-plate) text-(--gk-ink) shadow-(--gk-lip)">
					<header className="flex shrink-0 items-center gap-3 py-2.5 ps-3 pe-2.5">
						{lead ? (
							<SeatAvatar
								agent={lead}
								since={
									actTone === undefined && thread?.running
										? thread.updatedAt
										: undefined
								}
								size={28}
								tone={
									actTone ?? (lead.status === "working" ? "working" : "idle")
								}
							/>
						) : null}
						<div className="flex min-w-0 flex-1 flex-col">
							<h2
								className={cn(
									"gk-display truncate rounded-md text-[20px] leading-7",
									GAME_FOCUS
								)}
							>
								{title}
							</h2>
							<p className="flex min-w-0 items-center gap-1.5 truncate font-medium text-(--gk-ink-muted) text-[13px] leading-5">
								<span className="truncate">
									{lead ? lead.name : "No agent"}
									{others > 0 ? ` +${others}` : ""}
								</span>
								{thread ? <DrawerStatus now={now} thread={thread} /> : null}
							</p>
						</div>
						<GameIconButton
							label="Close thread"
							onClick={onClose}
							title="Close thread (Esc)"
						>
							<X aria-hidden="true" className="size-5" strokeWidth={2.5} />
						</GameIconButton>
					</header>
					<div className="mx-2 mb-2 min-h-0 flex-1 overflow-hidden rounded-2xl border-(--gk-edge) border-2 bg-background text-foreground">
						{threadView}
					</div>
				</div>
			</aside>
		</motion.div>
	);
}
