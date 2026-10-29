"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { VariantProps } from "class-variance-authority";
import type { CSSProperties } from "react";
import { buttonVariants } from "./button-variants.ts";
import {
	FadeOverflowText,
	FadeOverflowTextChildren,
} from "./fade-overflow-text.tsx";
import { Spinner } from "./spinner.tsx";

interface ButtonProgressStyle extends CSSProperties {
	"--button-progress": string;
}

type ButtonProps = ButtonPrimitive.Props &
	VariantProps<typeof buttonVariants> & {
		/** Fill percentage (0–100) for the `progress` variant. */
		progress?: number;
		/** Render the shared loading indicator and make the button unavailable. */
		loading?: boolean;
	};

function ButtonLabel({
	children,
	className,
}: {
	children: string;
	className?: string;
}) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<FadeOverflowText className={cn("min-w-0 max-w-full", className)}>
			{localizedChildren}
		</FadeOverflowText>
	);
}

function Button({
	className,
	variant = "default",
	size = "default",
	radius,
	spacing,
	edge,
	typography,
	appearance,
	progress,
	loading = false,
	disabled,
	"aria-busy": ariaBusy,
	children,
	...props
}: ButtonProps) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	const localizedAriaLabel = useLocalizedString(props["aria-label"]);
	const localizedTitle = useLocalizedString(props.title);
	const localizedProps = {
		...props,
		"aria-label": localizedAriaLabel,
		title: localizedTitle,
	};
	const isLoading = loading || variant === "loading";
	const classNameWithLoading = cn(
		buttonVariants({
			variant,
			size,
			radius,
			appearance,
			spacing,
			edge,
			typography,
			className,
		}),
		isLoading && "relative"
	);
	const buttonStateProps = {
		"aria-busy": isLoading ? true : ariaBusy,
		disabled: isLoading || disabled,
	};
	const loadingIndicator = isLoading ? (
		<Spinner className="pointer-events-none absolute end-1.5 top-1.5 size-3" />
	) : null;

	if (variant === "progress") {
		const value = Math.min(100, Math.max(0, progress ?? 0));
		const progressStyle: ButtonProgressStyle = {
			"--button-progress": `${value}%`,
		};

		return (
			<ButtonPrimitive
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={value}
				className={classNameWithLoading}
				data-cuelume-press=""
				data-cuelume-release=""
				data-slot="button"
				role="progressbar"
				{...localizedProps}
				{...buttonStateProps}
			>
				<span
					aria-hidden="true"
					className="absolute inset-y-0 start-0 w-(--button-progress) bg-[color-mix(in_oklch,var(--secondary-foreground),transparent_85%)] transition-[width] duration-300 ease-out"
					data-slot="button-progress-fill"
					style={progressStyle}
				/>
				<span className="relative inline-flex items-center justify-center gap-1.5">
					<FadeOverflowTextChildren>
						{localizedChildren}
					</FadeOverflowTextChildren>
				</span>
				{loadingIndicator}
			</ButtonPrimitive>
		);
	}

	return (
		<ButtonPrimitive
			className={classNameWithLoading}
			data-cuelume-press=""
			data-cuelume-release=""
			data-slot="button"
			{...localizedProps}
			{...buttonStateProps}
		>
			<FadeOverflowTextChildren>{localizedChildren}</FadeOverflowTextChildren>
			{loadingIndicator}
		</ButtonPrimitive>
	);
}

export type { ButtonProps };
export { Button, ButtonLabel };
