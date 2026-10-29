"use client";

import { SPRING_LAYOUT, SPRING_PRESS } from "@ryu/ui/lib/ease.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { MotionConfig, motion, useReducedMotion } from "motion/react";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useId,
	useMemo,
	useState,
} from "react";

interface RadioCtx {
	layoutId: string;
	setValue: (value: string) => void;
	value: string;
}

const RadioCtx = createContext<RadioCtx | null>(null);

function useRadioGroup() {
	const ctx = useContext(RadioCtx);
	if (!ctx) {
		throw new Error("RadioGroupItem must be used inside <RadioGroup>");
	}
	return ctx;
}

export interface RadioGroupProps {
	children: ReactNode;
	className?: string;
	defaultValue?: string;
	onValueChange?: (value: string) => void;
	orientation?: "vertical" | "horizontal";
	value?: string;
}

export function RadioGroup({
	value,
	defaultValue = "",
	onValueChange,
	children,
	className,
	orientation = "vertical",
}: RadioGroupProps) {
	const [internal, setInternal] = useState(defaultValue);
	const layoutId = useId();
	const reduce = useReducedMotion();
	const controlled = value !== undefined;
	const current = controlled ? value : internal;
	const setValue = useCallback(
		(next: string) => {
			if (!controlled) {
				setInternal(next);
			}
			onValueChange?.(next);
		},
		[controlled, onValueChange]
	);
	const contextValue = useMemo(
		() => ({ value: current, setValue, layoutId }),
		[current, layoutId, setValue]
	);

	return (
		<MotionConfig transition={reduce ? { duration: 0 } : SPRING_LAYOUT}>
			<RadioCtx.Provider value={contextValue}>
				<div
					className={cn(
						"flex gap-3",
						orientation === "vertical" ? "flex-col" : "flex-row flex-wrap",
						className
					)}
					role="radiogroup"
				>
					{children}
				</div>
			</RadioCtx.Provider>
		</MotionConfig>
	);
}

export interface RadioGroupItemProps {
	className?: string;
	disabled?: boolean;
	id?: string;
	label?: string;
	value: string;
}

export function RadioGroupItem({
	value,
	label,
	disabled,
	className,
	id: idProp,
}: RadioGroupItemProps) {
	const { value: groupValue, setValue, layoutId } = useRadioGroup();
	const autoId = useId();
	const id = idProp ?? autoId;
	const reduce = useReducedMotion();
	const selected = groupValue === value;

	return (
		<label
			className={cn(
				"inline-flex items-center gap-3",
				disabled ? "cursor-not-allowed" : "cursor-pointer",
				className
			)}
			htmlFor={id}
		>
			<motion.button
				aria-checked={selected}
				className={cn(
					"relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 outline-none transition-colors duration-200",
					"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
					"disabled:cursor-not-allowed disabled:opacity-60",
					selected
						? "border-primary"
						: "border-muted-foreground/50 hover:border-muted-foreground"
				)}
				data-state={selected ? "checked" : "unchecked"}
				disabled={disabled}
				id={id}
				onClick={() => !disabled && setValue(value)}
				role="radio"
				transition={SPRING_PRESS}
				type="button"
				whileTap={reduce || disabled ? undefined : { scale: 0.92 }}
			>
				{selected ? (
					<motion.span
						className="absolute inset-1 rounded-full bg-primary"
						layoutId={layoutId}
						transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
					/>
				) : null}
			</motion.button>
			{label ? (
				<span
					className={cn(
						"select-none text-foreground text-sm",
						disabled && "opacity-60"
					)}
				>
					{label}
				</span>
			) : null}
		</label>
	);
}
