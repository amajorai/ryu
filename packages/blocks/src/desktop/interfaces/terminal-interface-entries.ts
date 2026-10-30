import type { TerminalEntry, TerminalSegment } from "./terminal-output.tsx";

/** Scrollback kept in memory; older blocks scroll away like a real terminal. */
export const MAX_ENTRIES = 400;
export const MAX_HISTORY = 100;
/** At most this many live status notices are printed per snapshot update. */
export const MAX_NOTICES = 3;

export type WithoutId<Entry> = Entry extends unknown
	? Omit<Entry, "id">
	: never;
/** A scrollback block before it is given an id. */
export type NewEntry = WithoutId<TerminalEntry>;

export function line(...segments: TerminalSegment[]): NewEntry {
	return { kind: "line", segments };
}

/** A line printed without a command, so it gets its own block. */
export function notice(...segments: TerminalSegment[]): NewEntry {
	return { kind: "line", segments, standalone: true };
}

export function error(text: string): NewEntry {
	return line({ text, tone: "error" });
}

export function muted(text: string): NewEntry {
	return line({ text, tone: "muted" });
}
