"use client";

// Slide-to-confirm pill, adapted from the React Bits `SlideCommit` component
// (JavaScript + CSS variant) to TypeScript, theme tokens, a measured width and
// i18n'd defaults. The handle shows Ryu's cursor-following eyes (the `eyes`
// Logo variant) instead of an arrow. The handle is a `role="slider"`; End or
// the arrow keys commit from the keyboard.

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	animate,
	motion,
	useMotionValueEvent,
	useReducedMotion,
} from "motion/react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils.ts";
import { Logo } from "./logo.tsx";
import styles from "./slide-commit.module.css";
import {
	clamp,
	EASE_OUT,
	FALLBACK_WIDTH,
	finePointer,
	inkOn,
	isThenable,
	MIN_PENDING_MS,
	PAD,
	SHAKE,
	type SlideCommitPhase,
	type SlideCommitProps,
	SWELL,
	velocityOf,
} from "./slide-commit-config.ts";
import { arrowDelta, progressFromPointer } from "./slide-commit-direction.ts";
import { Spinner, useSlideCommitMotion } from "./slide-commit-motion.tsx";

export type { SlideCommitProps } from "./slide-commit-config.ts";

interface PointerHandlers {
	move: (event: PointerEvent) => void;
	up: (event: Pick<PointerEvent, "pointerId">) => void;
}

interface Grip {
	grab: number | null;
	history: [number, number][];
	id: number;
	moved: boolean;
}

export function SlideCommit({
	label,
	doneLabel,
	errorLabel,
	onConfirm,
	onDone,
	onError,
	trackColor,
	handleColor,
	successColor,
	dangerColor,
	width = FALLBACK_WIDTH,
	height = 56,
	radius = 28,
	speed = 50,
	returnBounce = 0.38,
	landingDip = 0.026,
	holdMs = 1500,
	keyboardSteps = 10,
	disabled = false,
	icon,
	className,
}: SlideCommitProps) {
	const tl = useLiteralMessages();
	const reduce = useReducedMotion() === true;
	const [phase, setPhase] = useState<SlideCommitPhase>("idle");
	const [held, setHeld] = useState(false);
	const [hot, setHot] = useState(false);

	const rootRef = useRef<HTMLDivElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const capsuleRef = useRef<HTMLDivElement>(null);
	const grip = useRef<Grip | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const homeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined
	);
	const run = useRef(0);
	const unwatch = useRef<(() => void) | null>(null);
	const live = useRef<PointerHandlers>({
		move: () => undefined,
		up: () => undefined,
	});
	const lastPercent = useRef(0);

	const GRIP = height - PAD * 2;
	const r = clamp(radius, 0, height / 2);
	const gripR = Math.max(0, r - PAD);
	const {
		anchor,
		arrow,
		clip,
		content,
		direction,
		inner: INNER,
		measured,
		origin,
		pulse,
		say,
		seen,
		shake,
		shape,
		shown,
		spin,
		trackTransform,
		x,
	} = useSlideCommitMotion({
		fallbackWidth: typeof width === "number" ? width : FALLBACK_WIDTH,
		gripRadius: gripR,
		height,
		rootRef,
		swellTarget: hot && !held && phase === "idle" && !reduce ? SWELL : 1,
	});
	const TRAVEL = INNER - GRIP;
	const stiffness = 260 + (clamp(speed, 0, 100) / 100) * 640;
	const mass = 0.9;
	const critical = 2 * Math.sqrt(stiffness * mass);
	const commitSpring = {
		type: "spring" as const,
		stiffness,
		damping: critical,
		mass,
	};
	const homeSpring = {
		...commitSpring,
		damping: critical * (1 - clamp(returnBounce, 0, 0.5)),
	};

	const labelText = typeof label === "string" ? label : tl("Slide to confirm");
	useMotionValueEvent(seen, "change", (v) => {
		const percent = Math.round((v / TRAVEL) * 100);
		if (percent === lastPercent.current || !capsuleRef.current) {
			return;
		}
		lastPercent.current = percent;
		capsuleRef.current.setAttribute("aria-valuenow", String(percent));
		capsuleRef.current.setAttribute(
			"aria-valuetext",
			`${labelText}, ${percent}%`
		);
	});

	useEffect(
		() => () => {
			clearTimeout(timer.current);
			clearTimeout(homeTimer.current);
			unwatch.current?.();
			run.current += 1;
		},
		[]
	);

	const local = (clientX: number) =>
		progressFromPointer(clientX, trackRef.current, measured, direction);

	const goHome = (velocity: number) => {
		if (reduce) {
			animate(x, 0, { duration: 0.2, ease: EASE_OUT });
		} else {
			animate(x, 0, { ...homeSpring, velocity: Math.min(0, velocity) });
		}
	};

	const settle = () => {
		setPhase("idle");
		animate(shown, 1, { duration: 0.2, delay: 0.12 });
		if (reduce) {
			anchor.set(0);
		} else {
			animate(anchor, 0, { type: "spring", duration: 0.3, bounce: 0 });
		}
	};

	const resolve = (viaKey: boolean) => {
		setPhase("done");
		anchor.set(x.get());
		animate(spin, 0, { duration: 0.12 });
		if (reduce) {
			x.set(0);
		} else {
			animate(x, 0, commitSpring);
			if (!viaKey && landingDip > 0) {
				animate(pulse, [1, 1 - landingDip, 1], {
					duration: 0.46,
					times: [0, 0.62, 1],
					ease: EASE_OUT,
					delay: 0.1,
				});
			}
		}
		onDone?.();
		if (holdMs > 0) {
			timer.current = setTimeout(settle, holdMs);
		}
	};

	const reject = (reason: unknown) => {
		setPhase("error");
		onError?.(reason);
		animate(spin, 0, { duration: 0.12 });
		animate(shown, 1, { duration: 0.2, delay: 0.12 });
		if (reduce) {
			goHome(0);
		} else {
			animate(shake, SHAKE, { duration: 0.45, ease: EASE_OUT });
			homeTimer.current = setTimeout(() => {
				if (!grip.current) {
					goHome(0);
				}
			}, 300);
		}
		timer.current = setTimeout(() => setPhase("idle"), Math.max(holdMs, 1500));
	};

	const commit = (viaKey: boolean) => {
		clearTimeout(timer.current);
		run.current += 1;
		const id = run.current;
		x.set(TRAVEL);
		let out: unknown;
		try {
			out = onConfirm?.();
		} catch (reason) {
			reject(reason);
			return;
		}
		if (!isThenable(out)) {
			animate(shown, 0, { duration: 0.12 });
			resolve(viaKey);
			return;
		}
		setPhase("pending");
		animate(shown, 0, { duration: 0.2 });
		animate(spin, 1, { duration: 0.2 });
		const startedAt = performance.now();
		const later = (fn: () => void) => {
			setTimeout(
				() => {
					if (id === run.current) {
						fn();
					}
				},
				Math.max(0, MIN_PENDING_MS - (performance.now() - startedAt))
			);
		};
		out.then(
			() => later(() => resolve(viaKey)),
			(reason: unknown) => later(() => reject(reason))
		);
	};

	const locked = disabled || phase === "pending" || phase === "done";

	const down = (event: React.PointerEvent<HTMLDivElement>) => {
		if (locked || grip.current || event.button !== 0) {
			return;
		}
		x.stop();
		grip.current = {
			id: event.pointerId,
			grab: null,
			moved: false,
			history: [],
		};
		setHeld(true);
		try {
			trackRef.current?.setPointerCapture(event.pointerId);
		} catch {
			// Capture is best-effort; window listeners below still track the drag.
		}
		unwatch.current?.();
		const onMove = (ev: PointerEvent) => ev.isTrusted && live.current.move(ev);
		const onUp = (ev: PointerEvent) => ev.isTrusted && live.current.up(ev);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		unwatch.current = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			unwatch.current = null;
		};
	};

	const move = (event: PointerEvent) => {
		const g = grip.current;
		if (!g || g.id !== event.pointerId) {
			return;
		}
		const at = local(event.clientX);
		if (g.grab === null) {
			g.grab = at - x.get();
			return;
		}
		const next = clamp(at - g.grab, 0, TRAVEL);
		if (Math.abs(next - x.get()) > 0.5) {
			g.moved = true;
		}
		g.history.push([event.timeStamp, next]);
		if (g.history.length > 4) {
			g.history.shift();
		}
		x.set(next);
	};

	const up = (event: Pick<PointerEvent, "pointerId">) => {
		const g = grip.current;
		if (!g || g.id !== event.pointerId) {
			return;
		}
		grip.current = null;
		unwatch.current?.();
		try {
			trackRef.current?.releasePointerCapture(event.pointerId);
		} catch {
			// The capture may already be gone (pointercancel); nothing to release.
		}
		setHeld(false);
		if (x.get() >= TRAVEL) {
			commit(false);
		} else if (g.moved) {
			goHome(velocityOf(g.history));
		}
	};
	live.current = { move, up };

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (locked) {
			return;
		}
		// After a failed confirm the handle is still parked or springing home: a
		// keyboard retry starts from home instead of being wiped by that reset.
		if (x.isAnimating() || (phase === "error" && x.get() >= TRAVEL - 0.5)) {
			clearTimeout(homeTimer.current);
			x.stop();
			x.set(0);
		}
		const step = TRAVEL / Math.max(1, keyboardSteps);
		if (event.key === "End") {
			event.preventDefault();
			commit(true);
		} else if (arrowDelta(event.key, direction) > 0) {
			event.preventDefault();
			const next = Math.min(TRAVEL, x.get() + step);
			x.set(next);
			if (next >= TRAVEL - 0.5) {
				commit(true);
			}
		} else if (arrowDelta(event.key, direction) < 0) {
			event.preventDefault();
			x.set(Math.max(0, x.get() - step));
		} else if (event.key === "Home" || event.key === "Escape") {
			if (event.key === "Escape" && x.get() === 0 && !grip.current) {
				return; // Let an enclosing dialog close.
			}
			event.preventDefault();
			if (grip.current) {
				up({ pointerId: grip.current.id });
			} else {
				x.set(0);
			}
		}
	};

	const fontSize = clamp(Math.round(height * 0.25), 13, 17);
	const iconSize = Math.round(GRIP * 0.42);
	const done = phase === "done";
	const vars: Record<string, string | undefined> = {
		"--sc-track": trackColor,
		"--sc-ink": handleColor,
		"--sc-ok": successColor,
		"--sc-no": dangerColor,
		"--sc-on-ink": inkOn(handleColor),
		"--sc-on-ok": inkOn(successColor),
		"--sc-on-no": inkOn(dangerColor),
		"--sc-radius": `${r}px`,
		"--sc-grip-r": `${gripR}px`,
		"--sc-pad": `${PAD}px`,
		"--sc-font": `${fontSize}px`,
		"--sc-label-inset": `${height}px`,
	};
	let liveText: React.ReactNode = "";
	if (phase === "pending") {
		liveText = tl("Working");
	} else if (phase === "done") {
		liveText = doneLabel ?? tl("Done");
	} else if (phase === "error") {
		liveText = errorLabel ?? tl("Something went wrong");
	}

	return (
		<div
			className={cn(styles.root, className)}
			data-disabled={disabled ? "" : undefined}
			data-held={held ? "" : undefined}
			data-phase={phase}
			data-slot="slide-commit"
			dir={direction}
			ref={rootRef}
			style={{ width, height, ...(vars as React.CSSProperties) }}
		>
			<motion.div
				className={styles.track}
				onPointerDown={down}
				ref={trackRef}
				style={{ transform: trackTransform }}
			>
				<motion.span
					aria-hidden="true"
					className={styles.label}
					style={{ opacity: say }}
				>
					<span className={cn(styles.text, styles.textPlain)}>
						{label ?? tl("Slide to confirm")}
					</span>
					<span className={cn(styles.text, styles.textError)}>
						{errorLabel ?? tl("Something went wrong")}
					</span>
				</motion.span>
				<motion.div
					aria-busy={phase === "pending" || undefined}
					aria-disabled={disabled || undefined}
					aria-label={labelText}
					aria-valuemax={100}
					aria-valuemin={0}
					aria-valuenow={0}
					className={styles.capsule}
					onKeyDown={onKeyDown}
					onPointerEnter={(event) => {
						if (event.pointerType === "mouse" && finePointer()) {
							setHot(true);
						}
					}}
					onPointerLeave={() => setHot(false)}
					ref={capsuleRef}
					role="slider"
					style={{ clipPath: clip, transform: shape, transformOrigin: origin }}
					tabIndex={disabled ? -1 : 0}
				>
					<motion.div className={styles.content} style={{ transform: content }}>
						<motion.span
							aria-hidden="true"
							className={styles.arrow}
							style={{ opacity: arrow }}
						>
							{icon ?? (
								<Logo size={`${Math.round(GRIP * 0.75)}px`} variant="eyes" />
							)}
						</motion.span>
						<motion.span
							aria-hidden="true"
							className={styles.spin}
							style={{ opacity: spin }}
						>
							<Spinner size={iconSize} />
						</motion.span>
						<motion.span
							animate={{
								opacity: done ? 1 : 0,
								scale: done || reduce ? 1 : 0.95,
							}}
							aria-hidden="true"
							className={styles.done}
							initial={false}
							transition={{ duration: 0.2, ease: EASE_OUT }}
						>
							<HugeiconsIcon
								icon={Tick02Icon}
								size={Math.round(GRIP * 0.38)}
								strokeWidth={2.5}
							/>
							{doneLabel ?? tl("Done")}
						</motion.span>
					</motion.div>
				</motion.div>
				<span aria-live="polite" className={styles.sr}>
					{liveText}
				</span>
			</motion.div>
		</div>
	);
}
