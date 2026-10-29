"use client";

import { ViewIcon, ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { Field, FieldError, FieldLabel } from "@ryu/ui/components/field";
import { Input } from "@ryu/ui/components/input";
import type { ReactNode } from "react";
import { useState } from "react";

interface PasswordFieldProps {
	autoComplete: string;
	autoFocus?: boolean;
	children?: ReactNode;
	descriptionIds?: string;
	disabled?: boolean;
	error?: string;
	errorId: string;
	id: string;
	label: string;
	name: string;
	onChange: (value: string) => void;
	placeholder: string;
	value: string;
}

/** The shared auth password field used by sign-in, sign-up, and re-verification. */
export default function PasswordField({
	autoComplete,
	autoFocus,
	children,
	descriptionIds,
	disabled,
	error,
	errorId,
	id,
	label,
	name,
	onChange,
	placeholder,
	value,
}: PasswordFieldProps) {
	const [showPassword, setShowPassword] = useState(false);
	const describedBy = [error ? errorId : undefined, descriptionIds]
		.filter((id): id is string => id !== undefined)
		.join(" ");

	return (
		<Field data-invalid={Boolean(error)}>
			<FieldLabel className="sr-only" htmlFor={id}>
				{label}
			</FieldLabel>
			<div className="relative w-full">
				<Input
					aria-describedby={describedBy || undefined}
					aria-invalid={Boolean(error)}
					autoComplete={autoComplete}
					autoFocus={autoFocus}
					className="h-16"
					disabled={disabled}
					id={id}
					name={name}
					onChange={(event) => onChange(event.target.value)}
					placeholder={placeholder}
					trailingAdornment="password-toggle"
					type={showPassword ? "text" : "password"}
					value={value}
					variant="muted"
				/>
				<Button
					aria-label={showPassword ? "Hide password" : "Show password"}
					aria-pressed={showPassword}
					className="absolute top-1/2 right-3 -translate-y-1/2"
					disabled={disabled}
					onClick={() => setShowPassword((visible) => !visible)}
					size="icon-sm"
					type="button"
					variant="ghost-muted"
				>
					<HugeiconsIcon
						icon={showPassword ? ViewOffSlashIcon : ViewIcon}
						strokeWidth={2}
					/>
				</Button>
			</div>
			{children}
			{error ? <FieldError errors={[{ message: error }]} id={errorId} /> : null}
		</Field>
	);
}
