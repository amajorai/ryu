import {
	isNativeObjectLike,
	isNativeText,
} from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import type { TextUIPart, UIMessage } from "ai";
import { memo } from "react";
import { CollapsibleText } from "./collapsible-text.tsx";
import { stripQuestionAnswerMarkers } from "./question/async-question.ts";
import { splitLeadingQuote } from "./quote.tsx";

function getMessageText(message: UIMessage): string {
	return (message.parts ?? [])
		.filter(
			(part): part is TextUIPart =>
				isNativeObjectLike(part) &&
				part !== null &&
				part.type === "text" &&
				isNativeText(part.text)
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
	const text = stripQuestionAnswerMarkers(getMessageText(message));
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
			{/* Line-height maths, all in `leading-5` (= 20px) units:
			      • collapsed box `max-h-15` = 3 lines (60px)
			      • fade strip `h-10`      = 2 lines (40px), and the gradient hits
			        full opacity at HALF its height
			    ⇒ the first opaque pixel lands at 60 − 20 = 40px, exactly the top of
			    line THREE. Lines one and two stay fully legible. With the previous
			    `max-h-10` box under the default `h-12` fade, the opaque edge landed
			    at 16px — inside line one — so the bar showed a single line and the
			    fade was pointless. Change the two classes together. */}
			<CollapsibleText
				collapsedMaxHeightClass="max-h-15"
				contentClassName="whitespace-pre-wrap text-foreground text-sm leading-5"
				contentKey={display}
				fadeHeightClass="h-10"
				fadeToClass="to-muted"
				onContentClick={onScrollTo}
			>
				{display}
			</CollapsibleText>
		</div>
	);
});
