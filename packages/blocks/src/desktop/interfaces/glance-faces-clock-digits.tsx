import { cn } from "@ryu/ui/lib/utils";
import { GLANCE_TYPE } from "./glance-faces-type-scale.ts";
import { glanceClock } from "./glance-model.ts";
import { GLANCE_INK_SECONDARY } from "./glance-parts.tsx";

export function ClockDigits({
	near,
	now,
	onArt = false,
}: {
	near: boolean;
	now: number;
	/** Over the flow art the date needs more ink than muted text gives. */
	onArt?: boolean;
}) {
	const date = new Date(now);
	const clock = glanceClock(date);
	return (
		<time
			className={cn("flex flex-col", near ? "gap-[1.4cqw]" : "gap-[2cqw]")}
			dateTime={date.toISOString()}
		>
			<span
				className={cn(
					"font-medium",
					onArt ? "text-foreground/75" : GLANCE_INK_SECONDARY,
					near ? GLANCE_TYPE.detail : GLANCE_TYPE.lead
				)}
			>
				{clock.date}
			</span>
			<span
				className={cn(
					"font-semibold text-foreground tabular-nums",
					near ? GLANCE_TYPE.clockNear : GLANCE_TYPE.clock
				)}
			>
				{clock.time}
				{clock.period ? <span className="sr-only"> {clock.period}</span> : null}
			</span>
		</time>
	);
}
