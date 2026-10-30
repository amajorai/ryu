import { cn } from "@ryu/ui/lib/utils";
import type { ThreadStatus } from "@ryuhq/protocol/interfaces";
import { Fragment, type ReactNode } from "react";
import {
	TERMINAL_STATUS_GLYPHS,
	TERMINAL_STATUS_WORDS,
	type TerminalAgentRow,
	type TerminalThreadRow,
} from "./terminal-model.ts";

export type TerminalTone =
	| "default"
	| "error"
	| "muted"
	| "primary"
	| "strong"
	| "success";

/** What a clickable piece of output does. */
export type TerminalAction =
	| { kind: "fill"; value: string }
	| { kind: "open"; threadId: string };

export interface TerminalSegment {
	action?: TerminalAction;
	/** Accessible name for an actionable segment. */
	label?: string;
	text: string;
	tone?: TerminalTone;
}

export type TerminalEntry =
	| { id: number; kind: "agents"; rows: TerminalAgentRow[] }
	| { id: number; kind: "banner" }
	| { id: number; kind: "command"; prompt: string; text: string }
	| { id: number; kind: "help" }
	| {
			id: number;
			kind: "line";
			segments: TerminalSegment[];
			/** Printed without a command (live notices, clicks): starts its own block. */
			standalone?: boolean;
	  }
	| {
			filter: ThreadStatus | "all";
			id: number;
			kind: "threads";
			now: number;
			rows: TerminalThreadRow[];
	  };

export const TONE_CLASS: Record<TerminalTone, string> = {
	default: "text-foreground",
	error: "text-destructive",
	muted: "text-muted-foreground",
	primary: "text-primary",
	strong: "font-medium text-foreground",
	success: "text-success",
};

/**
 * Tone of a status word. Your-turn and working never share a tone, so they
 * stay apart in themes where primary and success are the same hue.
 */
export const STATUS_TONE: Record<ThreadStatus, TerminalTone> = {
	attention: "error",
	quiet: "muted",
	waiting: "muted",
	working: "success",
	"your-turn": "default",
};

/** Tone of the glyph in front of a status word. */
export const STATUS_GLYPH_TONE: Record<ThreadStatus, TerminalTone> = {
	attention: "error",
	quiet: "muted",
	waiting: "muted",
	working: "success",
	"your-turn": "primary",
};

const LINK_CLASS =
	"rounded-xs underline-offset-4 outline-none hover:underline focus-visible:underline focus-visible:ring-2 focus-visible:ring-ring";

export type RunAction = (action: TerminalAction) => void;

export function ActionText({
	children,
	className,
	label,
	onAction,
	action,
}: {
	action: TerminalAction;
	children: ReactNode;
	className?: string;
	label: string;
	onAction: RunAction;
}) {
	return (
		<button
			aria-label={label}
			className={cn(LINK_CLASS, "text-left", className)}
			onClick={() => onAction(action)}
			type="button"
		>
			{children}
		</button>
	);
}

/**
 * A status glyph in a fixed 1ch cell plus a 1ch gap, so the word after it
 * always starts on the same column whatever the glyph's advance.
 */
export function StatusGlyph({ status }: { status: ThreadStatus }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"mr-[1ch] inline-block w-[1ch] text-center align-[0.05em] text-[13px] leading-none",
				TONE_CLASS[STATUS_GLYPH_TONE[status]]
			)}
		>
			{TERMINAL_STATUS_GLYPHS[status]}
		</span>
	);
}

/** A status glyph and word, toned so status never relies on color alone. */
export function TerminalStatus({ status }: { status: ThreadStatus }) {
	return (
		<>
			<StatusGlyph status={status} />
			<span className={TONE_CLASS[STATUS_TONE[status]]}>
				{TERMINAL_STATUS_WORDS[status]}
			</span>
		</>
	);
}

/**
 * A muted line of `·`-separated hints. Each separator travels with the item
 * after it, so a wrapped line never ends on a dangling dot.
 */
export function HintLine({
	className,
	parts,
}: {
	className?: string;
	parts: readonly string[];
}) {
	return (
		<p className={cn("text-muted-foreground", className)}>
			{parts.map((part, index) => (
				<Fragment key={part}>
					{index > 0 ? " " : null}
					<span className="whitespace-nowrap">
						{index > 0 ? "· " : null}
						{part}
					</span>
				</Fragment>
			))}
		</p>
	);
}

export function plural(count: number, word: string) {
	return `${count} ${count === 1 ? word : `${word}s`}`;
}
