"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Ticket } from "lucide-react";
import { useReducedMotion } from "motion/react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import styles from "./cut-to-confirm.module.css";
import {
	ARM_SLOP_PX,
	type CutToConfirmProps,
	clamp01,
	DEFAULT_ARM_MS,
	DEFAULT_CORRIDOR_PX,
	DEFAULT_THRESHOLD,
	GRIP_PX,
	type GripStyle,
	KEY_DELTAS,
	PERCENT,
	RETURN_MS,
	STEP,
	TEAR_MS,
} from "./cut-to-confirm-config.ts";
import { TEAR_LINE_RATIO, TearTicket } from "./tear-ticket.tsx";

export type { CutToConfirmProps } from "./cut-to-confirm-config.ts";

export function CutToConfirm({
	armMs = DEFAULT_ARM_MS,
	children,
	className,
	corridorPx = DEFAULT_CORRIDOR_PX,
	disabled = false,
	label,
	onAbort,
	onConfirm,
	onTearStart,
	renderHint,
	resetKey,
	threshold = DEFAULT_THRESHOLD,
}: CutToConfirmProps) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const rootRef = useRef<HTMLDivElement>(null);
	const gripRef = useRef<HTMLDivElement>(null);
	const [progress, setProgress] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [torn, setTorn] = useState(false);
	const [size, setSize] = useState({ height: 0, width: 0 });
	const [announcement, setAnnouncement] = useState("");

	// The single-commit latch. `progress === 1` is not enough on its own: a fifth
	// ArrowDown followed by a sixth, and a pointer release landing exactly at
	// threshold while the tear animation is already running, both re-enter the
	// commit path with progress already at 1.
	const committedRef = useRef(false);
	const armTimerRef = useRef<number | null>(null);
	const confirmAfterTearRef = useRef(false);
	const progressRef = useRef(0);
	const drag = useRef<{
		armed: boolean;
		/** Whether this pointer ever travelled. A press that did not is a TAP. */
		moved: boolean;
		pointerId: number;
		/** Progress when the pointer went down, so travel is relative to the grip
		 *  rather than to zero — otherwise a drag after a tap snaps the grip back
		 *  under the finger before it starts moving with it. */
		startProgress: number;
		startX: number;
		startY: number;
	} | null>(null);

	useEffect(() => {
		progressRef.current = progress;
	}, [progress]);

	// The card is sized by its own container, so the grip's down-track is only
	// knowable at runtime — and it changes when the dialog reflows on a rotate.
	useEffect(() => {
		const root = rootRef.current;
		if (!root) {
			return;
		}
		const measure = () =>
			setSize({ height: root.clientHeight, width: root.clientWidth });
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, []);

	useEffect(
		() => () => {
			if (armTimerRef.current !== null) {
				clearTimeout(armTimerRef.current);
			}
		},
		[]
	);

	// Start at the perforation and pull the stub down. Keep the full grip inside
	// the card at both ends, including before the first measure.
	const gripStartY = Math.min(
		Math.max(GRIP_PX / 2, size.height * TEAR_LINE_RATIO),
		Math.max(GRIP_PX / 2, size.height - GRIP_PX / 2)
	);
	const gripEndY = Math.max(
		gripStartY + 1,
		Math.min(size.height * threshold, size.height - GRIP_PX / 2)
	);
	const travelSpan = Math.max(1, gripEndY - gripStartY);

	const commit = useCallback(() => {
		if (committedRef.current) {
			return;
		}
		committedRef.current = true;
		confirmAfterTearRef.current = false;
		drag.current = null;
		setDragging(false);
		setProgress(1);
		setTorn(true);
		setAnnouncement("Ticket stub torn free.");
		onTearStart?.();
		// Under reduced motion there is no tear to wait on: the request was for
		// less movement, not for a slower confirmation.
		if (reduceMotion) {
			confirmAfterTearRef.current = true;
			onConfirm();
		}
	}, [onConfirm, onTearStart, reduceMotion]);

	const abort = useCallback(
		(wasArmed: boolean) => {
			drag.current = null;
			if (armTimerRef.current !== null) {
				clearTimeout(armTimerRef.current);
				armTimerRef.current = null;
			}
			setDragging(false);
			setTorn(false);
			setProgress(0);
			if (wasArmed) {
				onAbort?.();
			}
		},
		[onAbort]
	);

	/**
	 * One path for every DISCRETE act. An arrow press and a tap are the same act
	 * through different hardware, and both have to enter the commit latch from
	 * one place — two entrances is how a fifth tap and a fifth key press end up
	 * committing on different rules.
	 */
	const step = useCallback(
		(delta: number) => {
			if (committedRef.current) {
				return;
			}
			const previous = progressRef.current;
			const next = clamp01(previous + delta);
			progressRef.current = next;
			setProgress(next);
			if (next >= 1) {
				commit();
			} else if (next === 0 && previous > 0) {
				onAbort?.();
			}
		},
		[commit, onAbort]
	);

	// The ONLY way out of a commit. Everything else about the latch is one-way on
	// purpose — see the note on `committedRef`.
	useEffect(() => {
		if (resetKey === undefined) {
			return;
		}
		committedRef.current = false;
		confirmAfterTearRef.current = false;
		progressRef.current = 0;
		setTorn(false);
		setProgress(0);
		setAnnouncement("");
	}, [resetKey]);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (disabled || committedRef.current) {
				return;
			}
			// Fail closed until the card has actually been measured. `size` is 0 on
			// the first paint (the ResizeObserver has not fired, and the dialog is
			// still animating in), which collapses `travelSpan` to its 1px floor — a
			// single pixel of travel would then read as a completed tear.
			if (size.width < GRIP_PX * 2 || size.height < GRIP_PX * 2) {
				return;
			}
			// The card behind the grip is a `still` PassCardShell, so it never claims
			// the pointer — but the browser's own text/image drag still would, and
			// swallow the moves the stub reads.
			event.preventDefault();
			event.currentTarget.setPointerCapture(event.pointerId);
			drag.current = {
				armed: false,
				moved: false,
				pointerId: event.pointerId,
				startProgress: progressRef.current,
				startX: event.clientX,
				startY: event.clientY,
			};
			setDragging(true);
			armTimerRef.current = window.setTimeout(() => {
				armTimerRef.current = null;
				if (drag.current) {
					drag.current.armed = true;
				}
			}, armMs);
		},
		[armMs, disabled, size.height, size.width]
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const current = drag.current;
			if (
				!current ||
				current.pointerId !== event.pointerId ||
				committedRef.current
			) {
				return;
			}
			// The corridor separates a tear from a sideways drift. A finger that
			// leaves it was never pulling the stub free.
			if (Math.abs(event.clientX - current.startX) > corridorPx) {
				abort(current.armed);
				return;
			}
			const travelled =
				Math.hypot(
					event.clientX - current.startX,
					event.clientY - current.startY
				) > ARM_SLOP_PX;
			if (!current.armed) {
				// Moving during the dwell is a flick, not a grab. Aborting here (rather
				// than merely not counting the travel) is what stops a fast swipe from
				// arming late and then completing on the tail of the same gesture.
				if (travelled) {
					abort(false);
				}
				return;
			}
			// Past the slop this press is a drag, and a drag is never also a tap —
			// releasing it short of the threshold has to spring back, not advance.
			if (travelled) {
				current.moved = true;
			}
			const next = clamp01(
				current.startProgress + (event.clientY - current.startY) / travelSpan
			);
			progressRef.current = next;
			setProgress(next);
			if (next >= 1) {
				commit();
			}
		},
		[abort, commit, corridorPx, travelSpan]
	);

	const releaseCapture = (event: React.PointerEvent<HTMLDivElement>) => {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId);
		}
	};

	const handlePointerUp = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const current = drag.current;
			releaseCapture(event);
			if (!current || committedRef.current) {
				return;
			}
			// A press that never travelled is a TAP, and a tap advances one step —
			// the pointer route to 100% that needs no drag and no path. It is the
			// same five deliberate acts the keyboard asks for, so it cannot be the
			// one-click bypass that would make the whole gesture decoration.
			if (current.moved) {
				abort(current.armed);
				return;
			}
			drag.current = null;
			if (armTimerRef.current !== null) {
				clearTimeout(armTimerRef.current);
				armTimerRef.current = null;
			}
			setDragging(false);
			step(STEP);
		},
		[abort, step]
	);

	// NOT shared with `pointerup`. A cancelled pointer is the browser, the OS or a
	// palm taking the gesture away — treating that as a tap would let a rejected
	// touch put a fifth of a subscription cancellation on the board.
	const handlePointerCancel = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const current = drag.current;
			releaseCapture(event);
			if (!current || committedRef.current) {
				return;
			}
			abort(current.armed);
		},
		[abort]
	);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (disabled || committedRef.current) {
				return;
			}
			if (event.key === "Home") {
				event.preventDefault();
				// `-1` rather than a set-to-zero branch: `step` clamps, and retreat has
				// to fire `onAbort` on the same rule an arrow-key retreat does.
				step(-1);
				return;
			}
			const delta = KEY_DELTAS.get(event.key);
			if (delta === undefined) {
				return;
			}
			event.preventDefault();
			// A HELD arrow is one keypress. Without this, the OS's repeat rate — not
			// this component — decides how many of the five steps a single sustained
			// press is worth, and under `prefers-reduced-motion` `commit` fires
			// `onConfirm` synchronously, so there is not even a tear to notice.
			if (event.repeat) {
				return;
			}
			step(delta);
		},
		[disabled, step]
	);

	// Escape is bound natively rather than through React's `onKeyDown` because the
	// grip lives inside a Dialog whose dismiss listener sits on the document: a
	// synthetic `stopPropagation` runs at React's root container, too late to keep
	// the first Escape after arming from closing the whole dialog instead of
	// resetting the stub. At rest it is left alone, so Escape still dismisses.
	useEffect(() => {
		const grip = gripRef.current;
		if (!grip) {
			return;
		}
		const onEscape = (event: KeyboardEvent) => {
			// Committed is NOT armed. Past the commit there is nothing left to retreat
			// from — the handoff is already scheduled — so Escape must fall through to
			// the dialog's own dismiss rather than reset the stub and tell the user
			// nothing was cancelled while the tear timer runs out behind the copy.
			if (
				event.key !== "Escape" ||
				committedRef.current ||
				progressRef.current <= 0
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			abort(true);
		};
		grip.addEventListener("keydown", onEscape);
		return () => grip.removeEventListener("keydown", onEscape);
	}, [abort]);

	const percent = Math.round(progress * PERCENT);
	// The tap route is invisible on a control that looks like a slider, so the
	// slider's own value text is what advertises it — and it counts DOWN, which
	// is the number a user actually needs ("three more"), not the one they can
	// already see on the card.
	const stepsLeft = Math.max(0, Math.ceil((1 - progress) / STEP));
	const confirmAfterTear = useCallback(() => {
		if (!committedRef.current || confirmAfterTearRef.current) {
			return;
		}
		confirmAfterTearRef.current = true;
		onConfirm();
	}, [onConfirm]);

	const gripStyle: GripStyle = {
		"--grip-left": `${size.width / 2}px`,
		"--grip-top": `${gripStartY}px`,
		"--grip-transform": `translate(-50%, calc(-50% + ${progress * travelSpan}px))`,
		"--grip-transition":
			dragging || reduceMotion
				? undefined
				: `transform ${RETURN_MS}ms ease-out, opacity ${RETURN_MS}ms ease-out`,
	};

	return (
		<div className={cn("select-none", className)}>
			{/* The grip's frame of reference is the card, keeping its down-track aligned
			    with the perforation even though the hint sits below the card. */}
			<div className="relative" ref={rootRef}>
				<TearTicket
					durationMs={TEAR_MS}
					onTearComplete={confirmAfterTear}
					progress={progress}
					stubLabel="cancel"
					torn={torn}
				>
					{children}
				</TearTicket>

				<div
					aria-disabled={disabled || undefined}
					aria-label={label}
					aria-orientation="vertical"
					aria-valuemax={PERCENT}
					aria-valuemin={0}
					aria-valuenow={percent}
					aria-valuetext={
						stepsLeft === 0
							? "Stub detached."
							: tl(
									"{percent}% torn. {stepsLeft, plural, one {# more tap or arrow press} other {# more taps or arrow presses}} to tear the stub free.",
									{ percent, stepsLeft }
								)
					}
					className={cn(
						"absolute left-1/2 flex size-11 items-center justify-center rounded-full",
						// The hit area is DELIBERATELY bigger than the grip, and the margin
						// is not comfort — it is what makes the tap route usable. One step
						// carries the grip about 12px on the 19rem cancel card. A 64px
						// target overlaps the next position, so someone using a head pointer
						// or eye tracker can tap the same area through all five steps.
						styles.grip,
						"before:absolute before:-inset-2.5 before:rounded-full before:content-['']",
						"border border-destructive/50 bg-background/90 text-status-destructive shadow-lg backdrop-blur-sm",
						"outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2",
						disabled
							? "pointer-events-none opacity-40"
							: "cursor-ns-resize hover:border-destructive",
						torn && "opacity-0"
					)}
					onKeyDown={handleKeyDown}
					onPointerCancel={handlePointerCancel}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={handlePointerUp}
					ref={gripRef}
					role="slider"
					style={gripStyle}
					tabIndex={disabled ? -1 : 0}
				>
					<Ticket className="size-4" />
				</div>
			</div>

			{/* Arrow-key changes are announced by the slider role itself (via
			    `aria-valuetext`); this region exists for the terminal state, which no
			    role reports. */}
			<div aria-live="polite" className="sr-only">
				{announcement}
			</div>

			{renderHint ? <div className="mt-4">{renderHint(progress)}</div> : null}
		</div>
	);
}
