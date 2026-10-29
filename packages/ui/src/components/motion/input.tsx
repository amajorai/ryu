"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	animate,
	motion,
	useReducedMotion,
} from "motion/react";
import {
	forwardRef,
	type InputHTMLAttributes,
	type ReactNode,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { isNativeText } from "../../lib/native-primitive-observation.ts";

export interface InputClassNames {
	errorMessage?: string;
	field?: string;
	input?: string;
	label?: string;
	leftIcon?: string;
	rightIcon?: string;
	root?: string;
	successIcon?: string;
}

export interface InputProps
	extends Omit<
		InputHTMLAttributes<HTMLInputElement>,
		"value" | "defaultValue" | "onChange"
	> {
	className?: string;
	classNames?: InputClassNames;
	defaultValue?: string;
	/** Truthy error triggers a shake, red border and (if a string) a message. */
	error?: string | boolean;
	label?: string;
	leftIcon?: ReactNode;
	onChange?: (value: string) => void;
	rightIcon?: ReactNode;
	success?: boolean;
	value?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
	{
		label,
		value: valueProp,
		defaultValue,
		onChange,
		onFocus,
		onBlur,
		error,
		success,
		leftIcon,
		rightIcon,
		className,
		classNames,
		disabled,
		id: idProp,
		type,
		...rest
	},
	ref
) {
	const reactId = useId();
	const id = idProp ?? reactId;
	const reduce = useReducedMotion();

	const controlled = valueProp !== undefined;
	const [internal, setInternal] = useState(defaultValue ?? "");
	const value = controlled ? (valueProp ?? "") : internal;

	const [focused, setFocused] = useState(false);

	const fieldRef = useRef<HTMLDivElement>(null);

	const hasError = Boolean(error);
	const errorMessage = isNativeText(error) ? error : null;

	// Right edge shows the success check, otherwise the caller's right icon.
	const rightSlot = success ? null : rightIcon;

	// Shake the field when an error appears.
	useEffect(() => {
		if (!fieldRef.current || reduce || !hasError) {
			return;
		}
		animate(
			fieldRef.current,
			{ x: [0, -6, 6, -4, 4, -2, 0] },
			{ duration: 0.45 }
		);
	}, [hasError, reduce]);

	const handleChange = (next: string) => {
		if (!controlled) {
			setInternal(next);
		}
		onChange?.(next);
	};

	return (
		<div className={cn("flex flex-col gap-1.5", className, classNames?.root)}>
			{label ? (
				<label
					className={cn(
						"px-1 font-medium text-foreground text-sm",
						classNames?.label
					)}
					htmlFor={id}
				>
					{label}
				</label>
			) : null}

			<div
				className={cn(
					"relative h-11 overflow-hidden rounded-full border transition-colors duration-200",
					"border-border",
					focused && !hasError && "border-foreground/40 ring-2 ring-ring",
					hasError && "border-destructive ring-2 ring-destructive/25",
					disabled && "opacity-60",
					classNames?.field
				)}
				data-state={
					hasError
						? "error"
						: success
							? "success"
							: focused
								? "focused"
								: "idle"
				}
				ref={fieldRef}
			>
				{leftIcon ? (
					<span
						className={cn(
							"pointer-events-none absolute top-1/2 left-3 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4",
							classNames?.leftIcon
						)}
					>
						{leftIcon}
					</span>
				) : null}

				<input
					aria-describedby={errorMessage ? `${id}-error` : undefined}
					aria-invalid={hasError || undefined}
					disabled={disabled}
					id={id}
					ref={ref}
					type={type}
					value={value}
					{...rest}
					className={cn(
						"peer h-full w-full bg-transparent text-base text-foreground leading-6 caret-foreground outline-none",
						"placeholder:text-muted-foreground/60",
						leftIcon ? "pl-10" : "pl-3.5",
						rightSlot || success ? "pr-10" : "pr-3.5",
						disabled && "cursor-not-allowed",
						classNames?.input
					)}
					onBlur={(event) => {
						setFocused(false);
						onBlur?.(event);
					}}
					onChange={(e) => handleChange(e.target.value)}
					onFocus={(event) => {
						setFocused(true);
						onFocus?.(event);
					}}
				/>

				{success ? (
					<motion.svg
						className={cn(
							"absolute top-1/2 right-3.5 h-5 w-5 -translate-y-1/2 text-(--color-success)",
							classNames?.successIcon
						)}
						fill="none"
						viewBox="0 0 24 24"
					>
						<motion.path
							animate={{ pathLength: 1 }}
							d="M5 12.5l4.5 4.5L19 7.5"
							initial={reduce ? { pathLength: 1 } : { pathLength: 0 }}
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2.5}
							transition={{ duration: 0.35, ease: "easeOut" }}
						/>
					</motion.svg>
				) : rightSlot ? (
					<span
						className={cn(
							"absolute top-0 right-0 flex h-full items-center text-muted-foreground [&_button]:grid [&_button]:size-11 [&_button]:place-items-center [&_svg]:h-4 [&_svg]:w-4",
							classNames?.rightIcon
						)}
					>
						{rightSlot}
					</span>
				) : null}
			</div>

			<AnimatePresence initial={false}>
				{errorMessage ? (
					<motion.p
						animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
						className={cn(
							"px-1 text-status-destructive text-xs",
							classNames?.errorMessage
						)}
						exit={
							reduce
								? { opacity: 0 }
								: { opacity: 0, y: -4, filter: "blur(4px)" }
						}
						id={`${id}-error`}
						initial={
							reduce
								? { opacity: 0 }
								: { opacity: 0, y: -4, filter: "blur(4px)" }
						}
						role="alert"
						transition={{ duration: 0.2 }}
					>
						{errorMessage}
					</motion.p>
				) : null}
			</AnimatePresence>
		</div>
	);
});
