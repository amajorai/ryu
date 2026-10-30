import { Target01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

/** Compact transcript annotation shown beneath a goal-setting user message. */
export function GoalMessageAnnotation() {
	return (
		<span
			className="inline-flex items-center gap-1 text-muted-foreground/70 text-xs"
			data-testid="goal-message-annotation"
			title="This message was sent as a goal"
		>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5"
				icon={Target01Icon}
			/>
			<span>Sent as goal</span>
		</span>
	);
}
