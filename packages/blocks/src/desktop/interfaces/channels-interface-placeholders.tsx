import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { MessagesSquare, SquarePen } from "lucide-react";

/** Message skeleton text widths: one or two lines, never a uniform grid. */
const MESSAGE_SKELETON_LINES = [
	["w-3/4"],
	["w-full max-w-[560px]", "w-2/5"],
	["w-1/2"],
] as const;

/** The pane while the first snapshot loads: the header and three messages. */
export function PaneSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading channel"
			className="flex min-w-0 flex-1 flex-col"
			role="status"
		>
			<div className="flex h-12 shrink-0 items-center gap-2 border-border border-b px-5">
				<Skeleton className="size-4" radius="dense" />
				<Skeleton className="h-4 w-36" radius="dense" />
			</div>
			<div aria-hidden="true" className="mt-auto flex flex-col gap-4 px-5 py-4">
				{MESSAGE_SKELETON_LINES.map((lines) => (
					<div className="flex gap-3" key={lines.join()}>
						<Skeleton className="size-9 shrink-0" radius="dense" />
						<div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
							<Skeleton className="h-3 w-20" radius="dense" />
							{lines.map((width) => (
								<Skeleton
									className={cn("h-3", width)}
									key={width}
									radius="dense"
								/>
							))}
						</div>
					</div>
				))}
				<Skeleton className="mt-2 h-20 w-full" radius="panel" />
			</div>
		</div>
	);
}

/** No agents, so no channels: say what fills this space and offer the first step. */
export function NoAgents({ onCompose }: { onCompose: () => void }) {
	return (
		<div className="flex min-w-0 flex-1 items-center justify-center p-6">
			<Empty>
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<MessagesSquare aria-hidden="true" />
					</EmptyMedia>
					<EmptyTitle>No agents yet</EmptyTitle>
					<EmptyDescription className="text-foreground/70">
						Agents and teams you create appear here as channels and direct
						messages.
					</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onCompose} size="sm">
						<SquarePen aria-hidden="true" />
						New message
					</Button>
				</EmptyContent>
			</Empty>
		</div>
	);
}
