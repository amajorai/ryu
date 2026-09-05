"use client";

import {
	Cancel01Icon,
	CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	PASSWORD_RULES,
	passwordStrengthLabel,
	passwordStrengthScore,
} from "@ryu/auth/lib/password-policy";
import { cn } from "@ryu/ui/lib/utils";
import { motion, useReducedMotion } from "motion/react";

export function PasswordStrengthMeter({
	className,
	idPrefix = "password-strength",
	value,
}: {
	className?: string;
	idPrefix?: string;
	value: string;
}) {
	const score = passwordStrengthScore(value);
	const label = passwordStrengthLabel(score);
	const reduceMotion = useReducedMotion();

	return (
		<div
			className={cn("grid gap-2", className)}
			data-testid="password-strength-meter"
		>
			<div className="flex items-center justify-between gap-3 text-xs">
				<span
					className="font-medium text-muted-foreground"
					id={`${idPrefix}-label`}
				>
					Password strength
				</span>
				<motion.span
					animate={{ opacity: 1, y: 0 }}
					aria-live="polite"
					className="font-medium text-foreground"
					data-strength-label={label}
					initial={reduceMotion ? false : { opacity: 0, y: -2 }}
					transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
				>
					{label}
				</motion.span>
			</div>

			<div
				aria-label={`Password strength: ${label}`}
				aria-valuemax={PASSWORD_RULES.length}
				aria-valuemin={0}
				aria-valuenow={score}
				className="grid grid-cols-4 gap-1"
				data-strength-score={score}
				id={`${idPrefix}-bars`}
				role="progressbar"
			>
				{PASSWORD_RULES.map((rule, index) => (
					<span
						aria-hidden="true"
						className={cn(
							"h-1.5 rounded-full",
							index < score ? "bg-primary" : "bg-muted"
						)}
						key={rule.id}
					/>
				))}
			</div>

			<ul
				aria-label="Password requirements"
				className="grid gap-1 text-muted-foreground text-xs sm:grid-cols-2"
				id={`${idPrefix}-requirements`}
			>
				{PASSWORD_RULES.map((rule) => {
					const met = rule.test(value);
					return (
						<li
							className={cn(
								"flex items-center gap-1.5",
								met && "text-foreground"
							)}
							key={rule.id}
						>
							<HugeiconsIcon
								aria-hidden="true"
								className={cn(
									"size-3.5",
									met ? "text-emerald-500" : "text-muted-foreground/60"
								)}
								icon={met ? CheckmarkCircle02Icon : Cancel01Icon}
							/>
							<span>{rule.label}</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
