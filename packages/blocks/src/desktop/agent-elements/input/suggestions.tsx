"use client";

import { Button } from "@ryu/ui/components/button";
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
	className?: string;
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
}: SuggestionsProps) {
	if (items.length === 0) {
		return null;
	}

	return (
		<div className={cn("flex flex-wrap items-center gap-2", className)}>
			{items.map((item) => (
				<Button
					className={cn(
						"h-7 gap-1 rounded-md px-2 text-muted-foreground hover:text-foreground",
						itemClassName,
						item.className
					)}
					disabled={disabled}
					key={item.id}
					onClick={() => onSelect(item)}
					size="sm"
					type="button"
					variant="outline"
				>
					{item.icon && (
						<span className="inline-flex shrink-0">{item.icon}</span>
					)}
					{item.label}
				</Button>
			))}
		</div>
	);
}
