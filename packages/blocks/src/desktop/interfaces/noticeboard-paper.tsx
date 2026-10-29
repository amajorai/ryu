import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import type { CSSProperties, ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { type NoticeboardNote, noteByline } from "./noticeboard-model.ts";

/**
 * The papers pinned to the Noticeboard. Each one is plain card stock in the
 * user's theme; only the push pin carries color, and that color is the
 * thread's status, so a note moved anywhere on the board still says where it
 * stands.
 */

/** Push-pin head color per status; the same mapping the area labels use. */
export const PIN_COLOR: Record<ThreadStatus, string> = {
	attention: "bg-destructive",
	quiet: "bg-muted-foreground/50",
	waiting: "bg-muted-foreground",
	working: "bg-success",
	"your-turn": "bg-primary",
};

/**
 * A round push pin seen from above: a head, a highlight, a soft shadow. A
 * live run adds a slow halo, so "working" never depends on hue alone (some
 * themes make the primary and success colors both green).
 */
export function PushPin({
	className,
	status,
}: {
	className?: string;
	status: ThreadStatus;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"pointer-events-none absolute size-3 rounded-full shadow-foreground/40 shadow-sm ring-1 ring-foreground/15",
				PIN_COLOR[status],
				className
			)}
		>
			{status === "working" ? (
				<span className="absolute -inset-1 rounded-full ring-2 ring-success/30 motion-safe:animate-pulse" />
			) : null}
			<span className="absolute top-0.5 left-0.5 size-1 rounded-full bg-background/60" />
		</span>
	);
}

/** The pin's color as a small legend dot (area labels, the panel header). */
export function PinDot({
	className,
	halo = true,
	status,
}: {
	className?: string;
	/** The live-run halo; off where the dot sits tight against text. */
	halo?: boolean;
	status: ThreadStatus;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-block size-2 shrink-0 rounded-full",
				PIN_COLOR[status],
				className
			)}
		>
			{halo && status === "working" ? (
				<span className="absolute -inset-0.75 rounded-full ring-2 ring-success/30 motion-safe:animate-pulse" />
			) : null}
		</span>
	);
}

/** Two strips of matte tape across the top corners. */
function Tape({ angle }: { angle: number }) {
	const strip =
		"pointer-events-none absolute -top-1 h-4 w-11 bg-foreground/6 ring-1 ring-foreground/5";
	return (
		<>
			<span
				aria-hidden="true"
				className={cn(strip, "-left-2.5")}
				style={{ transform: `rotate(${-38 + angle}deg)` }}
			/>
			<span
				aria-hidden="true"
				className={cn(strip, "-right-2.5")}
				style={{ transform: `rotate(${38 + angle}deg)` }}
			/>
		</>
	);
}

/** The one line of state a note needs beyond its pin: live, failed, or age. */
function NoteState({
	age,
	dot,
	status,
}: {
	age: string;
	dot: boolean;
	status: ThreadStatus;
}) {
	if (status === "working") {
		return (
			<span className="flex shrink-0 items-center gap-1.5 font-medium text-success">
				<span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
				Working
			</span>
		);
	}
	if (status === "attention") {
		return (
			<span className="shrink-0 font-medium text-destructive">Run failed</span>
		);
	}
	return (
		<span className="flex shrink-0 items-center gap-1.5 text-muted-foreground tabular-nums">
			{dot ? (
				<span
					aria-hidden="true"
					className={cn("size-1.5 rounded-full", PIN_COLOR[status])}
				/>
			) : null}
			{age}
		</span>
	);
}

/** Who and when, along the bottom edge of every paper. */
function NoteFooter({
	age,
	avatar = true,
	note,
}: {
	age: string;
	avatar?: boolean;
	note: NoticeboardNote;
}) {
	const lead = note.agents[0];
	return (
		<div className="mt-auto flex h-5 items-center gap-2 text-[13px]">
			{avatar && lead ? (
				<BoardAvatar agent={lead} name={lead.name} size={20} />
			) : null}
			<span
				className={cn(
					"min-w-0 flex-1 truncate font-medium",
					lead ? "text-card-foreground/80" : "text-muted-foreground"
				)}
			>
				{noteByline(note)}
			</span>
			{/* Taped papers have no pin, so the status color moves down here. */}
			<NoteState
				age={age}
				dot={note.look.fastener === "tape"}
				status={note.status}
			/>
		</div>
	);
}

function Title({ children, lines }: { children: ReactNode; lines: 1 | 2 }) {
	return (
		<span
			className={cn(
				"font-semibold text-card-foreground text-sm leading-5",
				lines === 1 ? "truncate" : "line-clamp-2"
			)}
		>
			{children}
		</span>
	);
}

/** The latest message, up to three lines. */
function Message({ text }: { text: string | null }) {
	if (!text) {
		return (
			<span className="text-[13px] text-muted-foreground leading-5">
				No messages yet
			</span>
		);
	}
	return (
		<span className="line-clamp-4 text-[13px] text-card-foreground/70 leading-5">
			{text}
		</span>
	);
}

/** Thin ruled lines every 20px, aligned to the card's 20px line height. */
const RULED: CSSProperties = {
	backgroundImage:
		"repeating-linear-gradient(to bottom, transparent 0, transparent 19px, color-mix(in oklab, var(--border) 70%, transparent) 19px, color-mix(in oklab, var(--border) 70%, transparent) 20px)",
};

/** A sticky note: the paper washed in the theme's warning tone. */
function NotePaper({ age, note }: { age: string; note: NoticeboardNote }) {
	return (
		<span className="flex size-full flex-col gap-1.5 rounded-[inherit] bg-warning/12 px-4 pt-6 pb-4">
			<Title lines={2}>{note.thread.title}</Title>
			<Message text={note.thread.lastMessage} />
			<NoteFooter age={age} note={note} />
		</span>
	);
}

function IndexCard({ age, note }: { age: string; note: NoticeboardNote }) {
	return (
		<span className="flex size-full flex-col">
			<span className="flex h-12 shrink-0 items-end border-primary/40 border-b px-4 pb-2">
				<Title lines={1}>{note.thread.title}</Title>
			</span>
			{/* Text sits on the rules: one 20px line per rule, from the header down. */}
			<span className="flex min-h-0 flex-1 flex-col px-4 pb-1" style={RULED}>
				<Message text={note.thread.lastMessage} />
				<NoteFooter age={age} note={note} />
			</span>
		</span>
	);
}

/** A typed memo: a header strip, a subject line, and typewriter body text. */
function Memo({ age, note }: { age: string; note: NoticeboardNote }) {
	return (
		<span className="flex size-full flex-col">
			<span className="flex h-10 shrink-0 items-end justify-between gap-2 border-foreground/70 border-b-2 px-4 pb-1.5">
				<span className="font-mono font-semibold text-[13px] text-card-foreground uppercase tracking-[0.18em]">
					Memo
				</span>
				<span className="font-mono text-[12px] text-muted-foreground uppercase tracking-[0.12em]">
					Internal
				</span>
			</span>
			<span className="flex min-h-0 flex-1 flex-col gap-1.5 px-4 pt-3 pb-4">
				<span className="flex min-w-0 items-baseline gap-1.5">
					<span className="shrink-0 font-mono text-[12px] text-muted-foreground uppercase">
						Re:
					</span>
					<Title lines={2}>{note.thread.title}</Title>
				</span>
				<span className="line-clamp-4 font-mono text-[12.5px] text-card-foreground/75 leading-5">
					{note.thread.lastMessage ?? "No messages yet"}
				</span>
				<NoteFooter age={age} note={note} />
			</span>
		</span>
	);
}

/** The paper itself, sized by its kind, with its pin or tape. */
export function NoticeboardPaper({
	age,
	note,
}: {
	age: string;
	note: NoticeboardNote;
}) {
	const { look } = note;
	let body: ReactNode;
	if (look.kind === "card") {
		body = <IndexCard age={age} note={note} />;
	} else if (look.kind === "memo") {
		body = <Memo age={age} note={note} />;
	} else {
		body = <NotePaper age={age} note={note} />;
	}
	return (
		<>
			{body}
			{look.fastener === "pin" ? (
				<PushPin
					className={cn(
						"left-1/2 -translate-x-1/2",
						look.kind === "memo" ? "top-0.5" : "top-2"
					)}
					status={note.status}
				/>
			) : (
				<Tape angle={look.tapeAngle} />
			)}
		</>
	);
}
