import { Loader } from "@ryu/ui/components/motion/loader";
import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";

export interface TypingIndicatorProps {
	className?: string;
	/** Screen-reader status announced while the assistant is active. */
	label?: string;
}

/**
 * A quiet loading indicator for a live assistant response. Memoised: it sits
 * in the live turn row, which renders on every streamed chunk.
 */
export const TypingIndicator = memo(function TypingIndicator({
	label = "Assistant is typing",
	className,
}: TypingIndicatorProps) {
	return (
		<div
			aria-label={label}
			aria-live="polite"
			className={cn(
				"inline-flex items-center rounded-3xl border border-transparent bg-muted px-3 py-2 text-muted-foreground",
				className
			)}
			data-slot="chat-typing-indicator"
			data-testid="chat-typing-indicator"
			role="status"
		>
			<span aria-hidden="true" data-testid="chat-typing-dots">
				<Loader label="" size={14} speed={1.1} variant="dots" />
			</span>
		</div>
	);
});
