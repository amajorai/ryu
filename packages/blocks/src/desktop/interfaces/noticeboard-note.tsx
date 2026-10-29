import { cn } from "@ryu/ui/lib/utils";
import { motion } from "motion/react";
import type {
	KeyboardEvent as ReactKeyboardEvent,
	PointerEvent as ReactPointerEvent,
} from "react";
import {
	type NotePoint,
	type NoticeboardNote,
	noteAccessibleName,
} from "./noticeboard-model.ts";
import { NoticeboardPaper } from "./noticeboard-paper.tsx";

/** Marks a note's button so the board can find it again (focus return). */
export const NOTE_ATTRIBUTE = "data-noticeboard-note";

const SETTLE = {
	damping: 30,
	mass: 0.6,
	stiffness: 420,
	type: "spring",
} as const;
const INSTANT = { duration: 0 } as const;

/**
 * One paper on the board, as a button. Click (or Enter) lifts it off the
 * board and opens its conversation; dragging moves it; arrow keys nudge it.
 * The paper straightens and rises while it is lifted or carried.
 */
export function NoticeboardNoteButton({
	active,
	age,
	descriptionId,
	dragging,
	moved,
	note,
	onClick,
	onKeyDown,
	onPointerCancel,
	onPointerDown,
	onPointerMove,
	onPointerUp,
	point,
	reduceMotion,
}: {
	active: boolean;
	age: string;
	descriptionId: string;
	dragging: boolean;
	/** Moved by the viewer: sits above the tidy notes it was dropped on. */
	moved: boolean;
	note: NoticeboardNote;
	onClick: (threadId: string) => void;
	onKeyDown: (
		event: ReactKeyboardEvent<HTMLButtonElement>,
		threadId: string,
		point: NotePoint
	) => void;
	onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
	onPointerDown: (
		event: ReactPointerEvent<HTMLButtonElement>,
		threadId: string,
		point: NotePoint
	) => void;
	onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
	onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => void;
	point: NotePoint;
	reduceMotion: boolean;
}) {
	const lifted = active || dragging;
	const threadId = note.thread.id;
	return (
		<motion.button
			{...{ [NOTE_ATTRIBUTE]: threadId }}
			animate={{
				rotate: lifted ? 0 : note.look.rotation,
				scale: dragging ? 1.03 : 1,
				y: lifted ? -4 : 0,
			}}
			aria-current={active ? "true" : undefined}
			aria-describedby={descriptionId}
			aria-label={noteAccessibleName(note, age)}
			className={cn(
				"group absolute flex select-none rounded-[3px] bg-card text-start text-card-foreground outline-none",
				"shadow-foreground/15 shadow-sm transition-shadow duration-150",
				moved && "z-[5]",
				"hover:z-10 hover:shadow-foreground/15 hover:shadow-md",
				"focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted",
				active &&
					"z-20 shadow-foreground/20 shadow-xl ring-2 ring-primary hover:shadow-xl",
				dragging && "z-30 cursor-grabbing shadow-foreground/20 shadow-xl",
				!dragging && "cursor-pointer"
			)}
			data-thread-id={threadId}
			initial={false}
			onClick={() => onClick(threadId)}
			onKeyDown={(event) => onKeyDown(event, threadId, point)}
			onPointerCancel={onPointerCancel}
			onPointerDown={(event) => onPointerDown(event, threadId, point)}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			style={{
				height: note.size.height,
				left: point.x,
				top: point.y,
				width: note.size.width,
			}}
			transition={reduceMotion ? INSTANT : SETTLE}
			type="button"
		>
			<NoticeboardPaper age={age} note={note} />
		</motion.button>
	);
}
