import { getDateDisplayLabel } from "@platejs/date";
import { inlineSuggestionVariants } from "@ryu/ui/lib/suggestion.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TDateElement } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

export function DateElementStatic(props: SlateElementProps<TDateElement>) {
	const { element } = props;

	return (
		<SlateElement as="span" className="inline-block" {...props}>
			<span
				className={cn(
					"w-fit rounded-sm bg-muted px-1 text-muted-foreground",
					inlineSuggestionVariants()
				)}
			>
				{element.date || element.rawDate ? (
					getDateDisplayLabel(element)
				) : (
					<span>Pick a date</span>
				)}
			</span>
			{props.children}
		</SlateElement>
	);
}
