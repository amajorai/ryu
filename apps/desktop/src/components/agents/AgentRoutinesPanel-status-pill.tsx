import { cn } from "@ryu/ui/lib/utils.ts";
import { type RoutineStatus, STATUS_META } from "./AgentRoutinesPanel-model.ts";

export function StatusPill({ status }: { status: RoutineStatus }) {
	const meta = STATUS_META[status];
	return (
		<span
			className={cn("inline-flex items-center gap-1.5 text-xs", meta.className)}
		>
			<span
				aria-hidden="true"
				className={cn("size-1.5 rounded-full", meta.dotClassName)}
			/>
			{meta.label}
		</span>
	);
}
