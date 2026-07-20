"use client";

import { getLinkAttributes } from "@platejs/link";
import { inlineSuggestionVariants } from "@ryu/ui/lib/suggestion.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TLinkElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";

export function LinkElement(props: PlateElementProps<TLinkElement>) {
	return (
		<PlateElement
			{...props}
			as="a"
			attributes={{
				...props.attributes,
				...getLinkAttributes(props.editor, props.element),
				onMouseOver: (e) => {
					e.stopPropagation();
				},
			}}
			className={cn(
				"font-medium text-primary underline decoration-primary underline-offset-4",
				inlineSuggestionVariants()
			)}
		>
			{props.children}
		</PlateElement>
	);
}
