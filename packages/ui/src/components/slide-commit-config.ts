import type { ReactNode } from "react";

/**
 * Props for {@link SlideCommit}, a slide-to-confirm pill adapted from the
 * React Bits `SlideCommit` component. Colours default to the theme tokens
 * (`--muted`, `--foreground`, `--success`, `--destructive`); pass a colour
 * only to override them.
 */
export interface SlideCommitProps {
	className?: string;
	/** Tint of the handle and error label after a reject. Defaults to `--destructive`. */
	dangerColor?: string;
	disabled?: boolean;
	/** Words beside the check once confirmed. */
	doneLabel?: ReactNode;
	/** Replaces the instruction, in the danger colour, after a rejected promise. */
	errorLabel?: ReactNode;
	/** The handle and the ground it paints. Defaults to `--foreground`. */
	handleColor?: string;
	/** Track height in px; the handle is 8px smaller. */
	height?: number;
	/** How long the done pill stands before it closes back. 0 keeps it. */
	holdMs?: number;
	/** Replaces Ryu's cursor-following eyes in the handle. */
	icon?: ReactNode;
	/** Arrow presses needed to travel the full track by keyboard. */
	keyboardSteps?: number;
	/** The instruction centred in the pill; also the slider's accessible name when a string. */
	label?: ReactNode;
	/** How much the track dips as the done pill lands. 0 removes it. */
	landingDip?: number;
	/**
	 * Called when the handle reaches the end. Return a promise to show the
	 * spinner; it unfurls on resolve and springs home on reject.
	 */
	onConfirm?: () => unknown;
	/** Called when the done pill unfurls. */
	onDone?: () => void;
	/** Called with the rejection reason. */
	onError?: (reason: unknown) => void;
	/** Track corner radius in px; the handle radius stays concentric. */
	radius?: number;
	/** Energy left when the handle returns to the wall (0 – 0.5). */
	returnBounce?: number;
	/** How fast the unfurl and the return take over once released (0 – 100). */
	speed?: number;
	/** Fill of the done pill. Defaults to `--success`. */
	successColor?: string;
	/** The pill behind the handle. Defaults to `--muted`. */
	trackColor?: string;
	/** Track width: px, or any CSS length (e.g. `"100%"`); travel follows the measured width. */
	width?: number | string;
}

export type SlideCommitPhase = "idle" | "pending" | "done" | "error";

export const PAD = 4;
export const SQUASH_MAX = 0.08;
export const SQUASH_DIV = 110;
export const SWELL = 1.03;
export const MIN_PENDING_MS = 300;
export const FALLBACK_WIDTH = 280;
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;
export const SHAKE = [0, -5, 5, -3, 3, -1, 0];

export const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value));

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const YIQ_MIDPOINT = 128;

/** A readable ink for a hex fill, or `undefined` for non-hex colours (the CSS default applies). */
export function inkOn(color: string | undefined): string | undefined {
	if (!(color && HEX.test(color))) {
		return;
	}
	const raw = color.slice(1);
	const full =
		raw.length === 3 ? [...raw].map((ch) => ch + ch).join("") : raw.slice(0, 6);
	const n = Number.parseInt(full, 16);
	const yiq =
		(((n >> 16) & 255) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000;
	return yiq >= YIQ_MIDPOINT ? "#111111" : "#ffffff";
}

/** px/s over the recorded `[timeStamp, x]` samples. */
export function velocityOf(history: [number, number][]): number {
	const first = history[0];
	const last = history.at(-1);
	if (!(first && last) || history.length < 2) {
		return 0;
	}
	return ((last[1] - first[1]) / Math.max(1, last[0] - first[0])) * 1000;
}

export const finePointer = () =>
	typeof window !== "undefined" &&
	Boolean(window.matchMedia?.("(hover: hover) and (pointer: fine)").matches);

export function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}
