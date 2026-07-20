import { cn } from "@ryu/ui/lib/utils";
import type { UIMessage } from "ai";
import { memo } from "react";
import { CollapsibleText } from "./collapsible-text.tsx";
import { splitLeadingQuote } from "./quote.tsx";

function getMessageText(message: UIMessage): string {
	return (message.parts ?? [])
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: string }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
		)
		.map((part) => part.text)
		.join("");
}

export const PinnedUserMessageBar = memo(function PinnedUserMessageBar({
	message,
	onScrollTo,
	className,
}: {
	message: UIMessage;
	onScrollTo?: () => void;
	className?: string;
}) {
	const text = getMessageText(message);
	const { body } = splitLeadingQuote(text);
	const display = body || text;

	if (!display.trim()) {
		return null;
	}

	return (
		<div
			className={cn(
				"w-full rounded-xl bg-muted px-3.5 py-2 transition-colors",
				className
			)}
			title="Jump to message"
		>
			<CollapsibleText
				collapsedMaxHeightClass="max-h-10"
				contentClassName="whitespace-pre-wrap text-foreground text-sm leading-5"
				fadeToClass="to-muted"
				onContentClick={onScrollTo}
			>
				{display}
			</CollapsibleText>
		</div>
	);
});
