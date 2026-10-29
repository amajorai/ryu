"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useLocalizedText } from "@ryu/i18n/react";
import { buttonVariants } from "@ryu/ui/components/button";
import { FadeOverflowTextChildren } from "@ryu/ui/components/fade-overflow-text.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";

export interface SuggestionItem {
	className?: string;
	icon?: ReactNode;
	id: string;
	label: string;
	value?: string;
}

export interface SuggestionsProps {
	buttonSize?: "default" | "empty" | "follow-up";
	className?: string;
	containerClassName?: string;
	disabled?: boolean;
	itemClassName?: string;
	items: SuggestionItem[];
	onSelect: (item: SuggestionItem) => void;
}

export function Suggestions({
	items,
	onSelect,
	disabled,
	className,
	itemClassName,
	containerClassName,
	buttonSize = "default",
}: SuggestionsProps) {
	if (items.length === 0) {
		return null;
	}

	return (
		<div
			className={cn(
				"flex flex-wrap items-center gap-2",
				className,
				containerClassName
			)}
		>
			{items.map((item) => {
				const classes = cn(itemClassName, item.className);
				return (
					<SuggestionButton
						buttonSize={buttonSize}
						className={classes}
						disabled={disabled}
						key={item.id}
						onClick={() => onSelect(item)}
					>
						{item.icon && (
							<span className="inline-flex shrink-0">{item.icon}</span>
						)}
						{item.label}
					</SuggestionButton>
				);
			})}
		</div>
	);
}

/** Private suggestion control owns the caller override contract. It consumes
 * the shared Button recipe and underlying Base UI button/text behavior. */
function SuggestionButton({
	className,
	children,
	buttonSize,
	...props
}: ButtonPrimitive.Props & { buttonSize?: "default" | "empty" | "follow-up" }) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<ButtonPrimitive
			{...props}
			className={cn(
				buttonVariants({
					variant: "outline",
					size: "sm",
					appearance: "composer-suggestion",
				}),
				buttonSize === "empty" && "h-8 rounded-md px-3",
				buttonSize === "follow-up" && "h-8 rounded-full px-3",
				className
			)}
			data-cuelume-press=""
			data-cuelume-release=""
			data-slot="button"
			type="button"
		>
			<FadeOverflowTextChildren>{localizedChildren}</FadeOverflowTextChildren>
		</ButtonPrimitive>
	);
}
