import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Plus } from "lucide-react";

interface CalendarEmptyStateProps {
	hasAgents: boolean;
	newThread: (() => void) | null;
}

/** Shown over an empty grid: how threads get onto the calendar. */
export function CalendarEmptyState({
	hasAgents,
	newThread,
}: CalendarEmptyStateProps) {
	return (
		<div className="pointer-events-none absolute inset-x-0 top-9 bottom-0 flex items-center justify-center p-6">
			<Empty className="pointer-events-auto max-w-sm flex-none bg-background p-4">
				<EmptyHeader>
					<EmptyTitle>Nothing on the calendar yet</EmptyTitle>
					<EmptyDescription>
						{hasAgents
							? "Threads appear on the day they were last active."
							: "Add an agent to start a thread."}
					</EmptyDescription>
				</EmptyHeader>
				{newThread ? (
					<EmptyContent>
						<Button
							className="rounded-lg"
							onClick={newThread}
							size="sm"
							type="button"
							variant="outline"
						>
							<Plus aria-hidden="true" data-icon="inline-start" />
							New thread
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		</div>
	);
}
