"use client";

import { Input as InputPrimitive } from "@base-ui/react/input";
import { useLocalizedString } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

const inputVariants = cva(
	"w-full min-w-0 rounded-3xl border border-transparent bg-input/50 outline-none transition-[color,box-shadow,background-color] file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
	{
		variants: {
			size: {
				"agent-row": "h-8 px-3 py-1 text-base file:h-7 file:text-sm md:text-sm",
				"agent-detail":
					"type-detail h-8 px-3 py-1 text-base file:h-7 file:text-sm md:text-sm",
				default: "h-9 px-3 py-1 text-base file:h-7 file:text-sm md:text-sm",
				"settings-search":
					"h-8 px-3 py-1 text-base text-sm file:h-7 file:text-sm md:text-sm",
				compact: "h-8 px-3 py-1 text-xs file:h-7 file:text-sm md:text-sm",
				dense: "h-7 px-3 py-1 text-xs file:h-7 file:text-sm md:text-sm",
				lg: "h-10 px-4 py-2 text-base file:h-8 file:text-sm",
				caption:
					"type-caption h-7 px-3 py-1 text-base file:h-7 file:text-sm md:text-sm",
				"micro-dense":
					"type-compact h-7 px-3 py-1 text-base file:h-7 file:text-sm md:text-sm",
				micro:
					"type-compact h-6 px-3 py-1 text-base file:h-7 file:text-sm md:text-sm",
			},
			variant: {
				"agent-profile-name":
					"h-auto border-0 bg-transparent px-0 py-0 font-medium text-xl shadow-none focus-visible:ring-0",
				"agent-profile-description":
					"h-auto border-0 bg-transparent px-0 py-0 text-muted-foreground text-sm shadow-none focus-visible:ring-0",
				"blog-search": "h-14 border-none bg-muted pl-10 text-lg shadow-none",
				"store-search":
					"h-8 border-none bg-transparent shadow-none focus-visible:ring-0",
				"pricing-amount": "h-8 font-heading text-sm tabular-nums",
				"island-settings":
					"h-7 rounded-lg bg-input/50 px-2 py-1 text-foreground text-xs md:text-xs",
				"agent-title":
					"h-auto border-0 bg-transparent px-0 font-medium text-2xl shadow-none focus-visible:ring-0",
				"agent-description":
					"h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0",
				default: "",
				"document-search":
					"rounded-md border-border/80 bg-white dark:bg-space-search-dark",
				composer: "border-0 bg-transparent shadow-none",
				muted: "border-0 bg-muted shadow-none",
				"verification-code": "border-0 bg-muted font-mono text-2xl shadow-none",
				code: "font-mono",
				"code-caption": "font-mono text-xs",
				"picker-search":
					"text-(length:--text-detail) h-8 border-0 bg-transparent px-1 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
				title:
					"border-0 bg-transparent px-0 py-0 font-medium text-xl shadow-none focus-visible:ring-0 md:text-xl",
			},
			trailingAdornment: {
				"password-toggle": "pr-14",
				"password-reveal": "pr-10",
				compact: "pr-8",
			},
			leadingAdornment: {
				"search-icon": "pl-7",
				compact: "pl-8",
				default: "pl-9",
			},
			purpose: {
				"command-search":
					"border-0 bg-transparent p-0 text-base shadow-none focus-visible:ring-0",
				"space-title":
					"h-8 border-none bg-transparent px-0 font-medium text-base shadow-none focus-visible:ring-0",
				"space-row-title":
					"h-auto border-none bg-transparent px-0 font-medium text-2xl shadow-none focus-visible:ring-0",
				"picker-filter":
					"text-(length:--text-xs) h-7 border-0 bg-transparent pl-7",
				"picker-code-value": "text-(length:--text-xs) h-7",
				"model-filter": "text-(length:--text-detail) h-8",
				"model-identifier": "text-(length:--text-detail) h-7",
				"worktree-branch": "h-11 text-sm",
				"numeric-setting": "tabular-nums",
			},
			typography: { caption: "type-caption" },
			tone: {
				background: "bg-background",
				card: "bg-card",
				muted: "bg-muted",
				"observability-foreground": "text-foreground!",
			},
		},
		defaultVariants: {
			size: "default",
		},
	}
);

function Input({
	className,
	purpose,
	typography,
	tone,
	leadingAdornment,
	trailingAdornment,
	variant = "default",
	type,
	size = "default",
	...props
}: Omit<React.ComponentProps<"input">, "size"> &
	VariantProps<typeof inputVariants>) {
	const localizedAriaLabel = useLocalizedString(props["aria-label"]);
	const localizedPlaceholder = useLocalizedString(props.placeholder);
	const localizedTitle = useLocalizedString(props.title);
	return (
		<InputPrimitive
			className={cn(
				inputVariants({
					size,
					variant,
					purpose,
					typography,
					tone,
					leadingAdornment,
					trailingAdornment,
					className,
				})
			)}
			data-slot="input"
			type={type}
			{...props}
			aria-label={localizedAriaLabel}
			placeholder={localizedPlaceholder}
			title={localizedTitle}
		/>
	);
}

export { Input, inputVariants };
