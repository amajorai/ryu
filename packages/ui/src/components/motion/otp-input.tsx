"use client";

// beui.dev/components/blocks/otp-input

import { EASE_OUT } from "@ryu/ui/lib/ease";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	animate,
	motion,
	useReducedMotion,
} from "motion/react";
import type { ChangeEvent, ClipboardEvent, KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Slot-per-character code entry with a caret on the active slot, digits that
 * roll in, an error shake and a success check draw.
 *
 * This is the one code-entry primitive: 2FA/TOTP, emailed sign-in codes and the
 * device-activation flow all render it. The older `InputOTP` (components/input-otp.tsx,
 * shadcn over the `input-otp` package) is the static predecessor and has no call
 * sites left — do not reach for it in new code.
 *
 * `charset="alphanumeric"` covers device codes (better-auth issues 8 uppercase
 * characters shown as `XXXX-XXXX`); pair it with `groupSize` to draw that gap.
 * The hyphen is presentational — `value` is always the ungrouped characters.
 */

export type OTPStatus = "idle" | "error" | "success";

export interface OTPInputProps {
	/** Accessible label for the underlying input. */
	"aria-label"?: string;
	autoFocus?: boolean;
	/** Accepted characters. "alphanumeric" also upper-cases what is typed. */
	charset?: "numeric" | "alphanumeric";
	className?: string;
	defaultValue?: string;
	disabled?: boolean;
	/** Message shown below the slots when status is "error". */
	errorMessage?: string;
	/** Draws a wider gap after every nth slot, e.g. 4 for `XXXX-XXXX`. */
	groupSize?: number;
	/** Helper text shown below the slots while idle. */
	hint?: string;
	/** Optional label rendered above the slots. */
	label?: string;
	/** Number of slots. Default 6. */
	length?: number;
	/** Render dots instead of the typed characters. */
	mask?: boolean;
	onChange?: (value: string) => void;
	/** Fires once every slot is filled. */
	onComplete?: (value: string) => void;
	/** External validation feedback. "error" shakes, "success" draws a check. */
	status?: OTPStatus;
	/** Message shown below the slots when status is "success". */
	successMessage?: string;
	value?: string;
}

const NUMERIC_KEY = /^[0-9]$/;
const ALPHANUMERIC_KEY = /^[0-9a-zA-Z]$/;
const NON_NUMERIC = /[^0-9]/g;
const NON_ALPHANUMERIC = /[^0-9A-Z]/g;

export function OTPInput({
	length = 6,
	value: controlledValue,
	defaultValue = "",
	onChange,
	onComplete,
	label,
	hint,
	successMessage,
	errorMessage,
	status = "idle",
	charset = "numeric",
	groupSize,
	mask = false,
	disabled = false,
	autoFocus = false,
	"aria-label": ariaLabel = "One-time passcode",
	className,
}: OTPInputProps) {
	const uid = useId();
	const reduce = useReducedMotion();
	const inputRef = useRef<HTMLInputElement>(null);
	const slotsRef = useRef<HTMLDivElement>(null);

	const alphanumeric = charset === "alphanumeric";
	const controlled = controlledValue !== undefined;

	// Source of truth is a fixed-length array, so a cleared middle slot stays an
	// in-place hole instead of collapsing the characters after it to the left.
	const [slots, setSlots] = useState<string[]>(() =>
		toSlots(controlled ? controlledValue : defaultValue, length, alphanumeric)
	);
	const [focused, setFocused] = useState(false);
	const [active, setActive] = useState(0);

	const joined = slots.join("");
	const joinedRef = useRef(joined);

	useEffect(() => {
		joinedRef.current = joined;
	}, [joined]);

	// Pull in external value changes; skip when the parent is just echoing our own
	// onChange, so internal holes survive the controlled round-trip.
	useEffect(() => {
		if (!controlled) {
			return;
		}
		const incoming = sanitize(controlledValue, length, alphanumeric);
		if (incoming !== joinedRef.current) {
			setSlots(toSlots(incoming, length, alphanumeric));
			// The cursor has to follow an external rewrite. A parent that empties the
			// value after a rejected code would otherwise leave it parked on the last
			// slot, so every retyped character would overwrite that one slot and the
			// code could never complete again.
			setActive(Math.min(incoming.length, length - 1));
		}
	}, [controlled, controlledValue, length, alphanumeric]);

	const commit = (next: string[]) => {
		const wasComplete = slots.every((c) => c !== "");
		setSlots(next);
		const str = next.join("");
		onChange?.(str);
		// Fire only on the empty→full transition, not on every edit of a full code.
		if (!wasComplete && next.every((c) => c !== "")) {
			onComplete?.(str);
		}
	};

	const clearSlot = (idx: number) => {
		const next = [...slots];
		next[idx] = "";
		commit(next);
	};

	const slotFromClientX = (clientX: number) => {
		const els = slotsRef.current?.children;
		if (!els) {
			return 0;
		}
		for (let i = 0; i < els.length; i++) {
			const element = els[i];
			if (element && clientX < element.getBoundingClientRect().right) {
				return i;
			}
		}
		return length - 1;
	};

	// Single insertion path: one character overwrites the active slot and advances;
	// a multi-character chunk (paste / SMS autofill) fills forward from the active
	// slot.
	const insert = (raw: string, from = active) => {
		const chars = strip(raw, alphanumeric);
		if (!chars) {
			return;
		}
		const next = [...slots];
		let i = from;
		for (const ch of chars) {
			if (i >= length) {
				break;
			}
			next[i] = ch;
			i++;
		}
		commit(next);
		setActive(Math.min(i, length - 1));
	};

	// The keyboard is the single source of truth: preventDefault on keydown
	// reliably blocks native insertion (unlike beforeinput in React), so the hidden
	// input never accumulates a competing string and slot holes survive.
	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (disabled || e.metaKey || e.ctrlKey || e.altKey) {
			return;
		}
		const k = e.key;
		if ((alphanumeric ? ALPHANUMERIC_KEY : NUMERIC_KEY).test(k)) {
			e.preventDefault();
			insert(k);
		} else if (k === "Backspace") {
			e.preventDefault();
			// A filled slot clears in place; an empty slot steps back and clears there.
			if (slots[active]) {
				clearSlot(active);
			} else if (active > 0) {
				clearSlot(active - 1);
				setActive((current) => Math.max(current - 1, 0));
			}
		} else if (k === "Delete") {
			e.preventDefault();
			clearSlot(active);
		} else if (k === "ArrowLeft") {
			e.preventDefault();
			setActive((a) => Math.max(a - 1, 0));
		} else if (k === "ArrowRight") {
			e.preventDefault();
			setActive((a) => Math.min(a + 1, length - 1));
		} else if (k === "Home") {
			e.preventDefault();
			setActive(0);
		} else if (k === "End") {
			e.preventDefault();
			setActive(length - 1);
		}
	};

	const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
		if (disabled) {
			return;
		}
		// preventDefault suppresses the duplicate onChange, keeping that path
		// autofill-only.
		e.preventDefault();
		insert(e.clipboardData.getData("text"), active);
	};

	// Autofill path: an SMS/email one-time code arrives as a whole value in one
	// shot. Keystrokes go through onKeyDown and paste through onPaste, so only
	// autofill reaches here — spread it across the slots from the start.
	const onChangeNative = (e: ChangeEvent<HTMLInputElement>) => {
		const chars = sanitize(e.target.value, length, alphanumeric);
		if (!chars) {
			return;
		}
		commit(toSlots(chars, length, alphanumeric));
		setActive(Math.min(chars.length, length - 1));
	};

	// Error shake — imperative so it replays on every transition into "error".
	useEffect(() => {
		if (status !== "error" || reduce || !slotsRef.current) {
			return;
		}
		animate(
			slotsRef.current,
			{ x: [0, -5, 5, -3, 3, -1, 0] },
			{ duration: 0.45, ease: EASE_OUT }
		);
	}, [status, reduce]);

	const showSuccess = status === "success";
	const isError = status === "error";
	const activeIndex = focused ? active : -1;
	let message = hint;
	if (showSuccess) {
		message = successMessage;
	} else if (isError) {
		message = errorMessage;
	}

	return (
		<div className={cn("inline-flex flex-col gap-2", className)}>
			{label ? (
				<label
					className="font-medium text-foreground text-sm"
					htmlFor={`${uid}-input`}
				>
					{label}
				</label>
			) : null}
			<fieldset
				className="relative m-0 inline-flex w-max border-0 p-0"
				onMouseDown={(e) => {
					if (disabled) {
						return;
					}
					// Suppress the native click-caret; we drive the active slot ourselves.
					e.preventDefault();
					// Clamp to the first empty slot so a click can't jump ahead of progress.
					const firstEmpty = slots.indexOf("");
					const cap = firstEmpty === -1 ? length - 1 : firstEmpty;
					setActive(Math.min(slotFromClientX(e.clientX), cap));
					inputRef.current?.focus();
				}}
			>
				<input
					aria-invalid={isError}
					aria-label={ariaLabel}
					autoCapitalize={alphanumeric ? "characters" : "off"}
					autoComplete="one-time-code"
					// biome-ignore lint/a11y/noAutofocus: opt-in via prop for code-first screens.
					autoFocus={autoFocus}
					// Transparent overlay owns focus, the soft keyboard, paste and autofill;
					// the slots below are purely presentational.
					className="absolute inset-0 z-20 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none disabled:cursor-not-allowed"
					disabled={disabled}
					id={`${uid}-input`}
					inputMode={alphanumeric ? "text" : "numeric"}
					maxLength={length}
					onBlur={() => setFocused(false)}
					onChange={onChangeNative}
					onFocus={() => setFocused(true)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					ref={inputRef}
					spellCheck={false}
					// Kept empty on purpose — our state owns the characters, native holds none.
					value=""
				/>

				<div className="flex items-center gap-2" ref={slotsRef}>
					{Array.from({ length }, (_, i) => {
						const char = slots[i] ?? "";
						const isActive = i === activeIndex;
						const endsGroup =
							groupSize && i < length - 1 && (i + 1) % groupSize === 0;
						return (
							<div
								className={cn(
									"relative grid h-14 w-12 place-items-center overflow-hidden rounded-2xl border bg-input/50 font-medium text-xl tabular-nums transition-all duration-200",
									showSuccess && "border-success text-foreground",
									isError && "border-destructive text-foreground",
									!(showSuccess || isError) &&
										(char
											? "border-input text-foreground"
											: "border-input text-muted-foreground"),
									// Active slot reads stronger; twMerge lets this win the border.
									isActive &&
										!(showSuccess || isError) &&
										"z-10 border-ring ring-3 ring-ring/30",
									endsGroup && "mr-3",
									disabled && "opacity-50"
								)}
								data-active={isActive}
								data-filled={char !== ""}
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length slot grid, never reordered.
								key={`${uid}-${i}`}
							>
								{/* Blinking caret marks the active slot — centered when empty,
                    trailing the character when the slot is already filled. */}
								{isActive && !showSuccess ? (
									<motion.span
										animate={reduce ? undefined : { opacity: [1, 1, 0, 0] }}
										aria-hidden
										className={cn(
											"pointer-events-none absolute top-1/2 h-6 w-px -translate-y-1/2 bg-foreground",
											char ? "right-3" : "left-1/2 -translate-x-1/2"
										)}
										transition={
											reduce
												? undefined
												: {
														duration: 1,
														repeat: Number.POSITIVE_INFINITY,
														ease: "linear",
													}
										}
									/>
								) : null}

								{/* Characters roll vertically. Each is absolutely centered so
                    enter and exit overlap in place — no in-flow reflow, no
                    sideways drift. */}
								<AnimatePresence initial={false}>
									{char ? (
										<motion.span
											animate={
												reduce
													? { opacity: 1 }
													: { y: 0, opacity: 1, filter: "blur(0px)" }
											}
											className="absolute inset-0 grid place-items-center leading-none"
											exit={
												reduce
													? { opacity: 0 }
													: { y: -14, opacity: 0, filter: "blur(4px)" }
											}
											initial={
												reduce
													? { opacity: 0 }
													: { y: 14, opacity: 0, filter: "blur(4px)" }
											}
											key={char}
											transition={
												reduce
													? { duration: 0 }
													: { duration: 0.22, ease: EASE_OUT }
											}
										>
											{mask ? "•" : char}
										</motion.span>
									) : null}
								</AnimatePresence>
							</div>
						);
					})}
				</div>

				<AnimatePresence>
					{showSuccess ? (
						<motion.span
							animate={reduce ? { opacity: 1 } : { scale: 1, opacity: 1 }}
							aria-hidden
							className="pointer-events-none absolute top-1/2 -right-7 -translate-y-1/2 text-success"
							exit={reduce ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
							initial={reduce ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
							transition={
								reduce
									? { duration: 0 }
									: { type: "spring", stiffness: 500, damping: 28 }
							}
						>
							<svg
								fill="none"
								height="20"
								stroke="currentColor"
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={3}
								viewBox="0 0 24 24"
								width="20"
							>
								<title>Verified</title>
								<motion.path
									animate={{ pathLength: 1 }}
									d="M5 13l4 4L19 7"
									initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
									transition={
										reduce
											? { duration: 0 }
											: { duration: 0.35, ease: EASE_OUT, delay: 0.1 }
									}
								/>
							</svg>
						</motion.span>
					) : null}
				</AnimatePresence>
			</fieldset>

			{message ? (
				<p
					aria-live="polite"
					className={cn(
						"text-sm",
						showSuccess && "text-success",
						isError && "text-destructive",
						!(showSuccess || isError) && "text-muted-foreground"
					)}
				>
					{message}
				</p>
			) : null}
		</div>
	);
}

function strip(raw: string, alphanumeric: boolean) {
	return alphanumeric
		? raw.toUpperCase().replace(NON_ALPHANUMERIC, "")
		: raw.replace(NON_NUMERIC, "");
}

function sanitize(raw: string, length: number, alphanumeric: boolean) {
	return strip(raw, alphanumeric).slice(0, length);
}

function toSlots(raw: string, length: number, alphanumeric: boolean) {
	const chars = sanitize(raw, length, alphanumeric);
	return Array.from({ length }, (_, i) => chars[i] ?? "");
}

export default OTPInput;
