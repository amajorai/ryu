"use client";

// beui.dev/components/blocks/otp-input

import type { MotionStyle } from "motion/react";
import css from "./otp-input.module.css";

interface Inline1Style extends MotionStyle {
	"--otp-input-1-transform-origin"?: MotionStyle["transformOrigin"];
	"--otp-input-1-transform-style"?: MotionStyle["transformStyle"];
}

import { EASE_OUT } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	animate,
	motion,
	useReducedMotion,
} from "motion/react";
import {
	type ChangeEvent,
	type ClipboardEvent,
	Fragment,
	type KeyboardEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";

/**
 * Slot-per-character code entry with a caret on the active slot, digits that
 * roll in, an error shake and a success check draw.
 *
 * This is the one code-entry primitive: 2FA/TOTP, emailed sign-in codes and the
 * device-activation flow all render it. The older `InputOTP` (components/input-otp.tsx,
 * shadcn over the `input-otp` package) is the static predecessor and has no call
 * sites left — do not reach for it in new code.
 *
 * `charset="alphanumeric"` covers device codes. Even lengths of six or more
 * split at their midpoint by default; `groupSize` overrides that separator.
 * Separators are presentational — `value` is always ungrouped. `OTPCodeDisplay`
 * normalizes a returned code and uses its actual length with these same slots.
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
	/** Split point for a visual separator; by default even codes split in half. */
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
	/** Render filled slots as a non-interactive code display. */
	readOnly?: boolean;
	/** Smaller slots for codes shown inside dense panels. */
	size?: "compact" | "default";
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
	readOnly = false,
	size = "default",
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
	const effectiveGroupSize =
		groupSize ?? (length >= 6 && length % 2 === 0 ? length / 2 : undefined);

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
		const els =
			slotsRef.current?.querySelectorAll<HTMLElement>("[data-otp-index]");
		if (!els) {
			return 0;
		}
		for (const element of els) {
			if (element && clientX < element.getBoundingClientRect().right) {
				return Number(element.dataset.otpIndex);
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
		if (disabled || readOnly || e.metaKey || e.ctrlKey || e.altKey) {
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
		if (disabled || readOnly) {
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
		if (readOnly) {
			return;
		}
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
	const isComplete = slots.every((char) => char !== "");
	const activeIndex =
		focused && !(isComplete && active === length - 1) ? active : -1;
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
					if (disabled || readOnly) {
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
					autoComplete={readOnly ? "off" : "one-time-code"}
					autoFocus={autoFocus}
					// Transparent overlay owns focus, the soft keyboard, paste and autofill;
					// the slots below are purely presentational.
					className={cn(
						"absolute inset-0 z-20 h-full w-full cursor-text bg-transparent text-transparent caret-transparent opacity-0 outline-none disabled:cursor-not-allowed",
						readOnly && "pointer-events-none"
					)}
					disabled={disabled}
					id={`${uid}-input`}
					inputMode={alphanumeric ? "text" : "numeric"}
					maxLength={length}
					onBlur={() => setFocused(false)}
					onChange={onChangeNative}
					onFocus={() => setFocused(true)}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					readOnly={readOnly}
					ref={inputRef}
					spellCheck={false}
					tabIndex={readOnly ? -1 : undefined}
					// Editable entry stays empty; read-only displays expose their value to assistive tech.
					value={readOnly ? joined : ""}
				/>

				<div
					className={cn(
						"flex items-center",
						size === "compact" ? "gap-1" : "gap-[clamp(0.25rem,2vw,0.75rem)]"
					)}
					ref={slotsRef}
				>
					{Array.from({ length }, (_, i) => {
						const char = slots[i] ?? "";
						const isActive = i === activeIndex;
						const endsGroup =
							effectiveGroupSize &&
							i < length - 1 &&
							(i + 1) % effectiveGroupSize === 0;
						const inline1Style: Inline1Style = {
							"--otp-input-1-transform-origin": "center bottom",
							"--otp-input-1-transform-style": "preserve-3d",
						};
						return (
							<Fragment key={`${uid}-${i}`}>
								<div
									className={cn(
										"relative grid aspect-square min-w-0 place-items-center overflow-hidden rounded-xl bg-foreground/[0.06] font-semibold tabular-nums outline-none ring-1 ring-foreground/10 transition-[background-color,color] duration-150 ease-out [container-type:inline-size] motion-reduce:transition-none",
										size === "compact"
											? "h-9 w-9 rounded-lg text-sm *:text-[min(0.875rem,43cqi)]"
											: "h-[clamp(2rem,8vw,3.5rem)] w-[clamp(2rem,8vw,3.5rem)] text-2xl *:text-[min(1.5rem,43cqi)]",
										showSuccess &&
											"bg-status-success/10 ring-status-success/50",
										isError && "bg-destructive/5 ring-destructive/40",
										isActive &&
											!(showSuccess || isError) &&
											"z-10 bg-foreground/10",
										disabled && "opacity-50"
									)}
									data-active={isActive}
									data-filled={char !== ""}
									data-index={i}
									data-otp-index={i}
								>
									{isActive && !showSuccess ? (
										<motion.span
											aria-hidden
											className={cn(
												"pointer-events-none absolute inset-0 z-20 rounded-[inherit] ring-3",
												isError ? "ring-destructive" : "ring-foreground/75"
											)}
											layoutId={reduce ? undefined : `${uid}-active-ring`}
											transition={
												reduce
													? { duration: 0 }
													: { type: "spring", duration: 0.25, bounce: 0.18 }
											}
										/>
									) : null}
									{char ? null : (
										<span
											aria-hidden
											className="select-none text-foreground/20"
										>
											{alphanumeric ? "·" : "0"}
										</span>
									)}
									<AnimatePresence initial={false}>
										{char ? (
											<motion.span
												animate={
													reduce
														? { opacity: 1 }
														: {
																y: 0,
																opacity: 1,
																rotateX: 0,
																filter: "blur(0px)",
															}
												}
												className={[
													css.inline1,
													"absolute inset-0 grid place-items-center text-foreground leading-none",
												].join(" ")}
												exit={
													reduce
														? { opacity: 0 }
														: {
																y: -2,
																opacity: 0,
																rotateX: 15,
																filter: "blur(2px)",
															}
												}
												initial={
													reduce
														? { opacity: 0 }
														: {
																y: 6,
																opacity: 0,
																rotateX: -35,
																filter: "blur(2px)",
															}
												}
												key={`${i}-${char}`}
												style={inline1Style}
												transition={
													reduce
														? { duration: 0 }
														: { type: "spring", duration: 0.25, bounce: 0.2 }
												}
											>
												{mask ? "•" : char}
											</motion.span>
										) : null}
									</AnimatePresence>
								</div>
								{endsGroup ? (
									<span
										aria-hidden
										className={cn(
											"flex shrink-0 items-center justify-center text-muted-foreground/70",
											size === "compact" ? "w-2" : "w-3"
										)}
										data-otp-separator
									>
										<span className="h-px w-2.5 rounded-full bg-current" />
									</span>
								) : null}
							</Fragment>
						);
					})}
				</div>

				<AnimatePresence>
					{showSuccess ? (
						<motion.span
							animate={reduce ? { opacity: 1 } : { scale: 1, opacity: 1 }}
							aria-hidden
							className="pointer-events-none absolute top-1/2 -right-7 -translate-y-1/2 text-status-success"
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
						showSuccess && "text-status-success",
						isError && "text-status-destructive",
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

export interface OTPCodeDisplayProps {
	"aria-label"?: string;
	className?: string;
	/** Code text from an auth or device-pairing response. */
	code: string;
	size?: "compact" | "default";
}

/** Read-only rendering of a code with the shared OTP slot treatment. */
export function OTPCodeDisplay({
	"aria-label": ariaLabel = "Verification code",
	className,
	code,
	size = "default",
}: OTPCodeDisplayProps) {
	const value = code.toUpperCase().replace(NON_ALPHANUMERIC, "");
	if (!value) {
		return null;
	}

	return (
		<OTPInput
			aria-label={ariaLabel}
			charset="alphanumeric"
			className={className}
			groupSize={
				value.length >= 6 && value.length % 2 === 0
					? value.length / 2
					: undefined
			}
			length={value.length}
			readOnly
			size={size}
			value={value}
		/>
	);
}

export default OTPInput;
