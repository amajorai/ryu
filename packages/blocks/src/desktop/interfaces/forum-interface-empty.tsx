import { Button } from "@ryu/ui/components/button.tsx";
import { MessagesSquare, Plus } from "lucide-react";

/** The board before any agent or thread exists. */
export function ForumEmpty({ onNewTopic }: { onNewTopic: () => void }) {
	return (
		<div
			className="flex flex-col items-center border-border border-t px-6 py-20 text-center"
			data-testid="forum-empty"
		>
			<span className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
				<MessagesSquare
					aria-hidden="true"
					className="size-5"
					strokeWidth={1.75}
				/>
			</span>
			<h2 className="mt-4 font-medium text-base text-foreground">
				No topics yet
			</h2>
			<p className="mt-1 max-w-sm text-muted-foreground text-sm leading-6">
				Topics are conversations with your agents. Each one is filed under its
				project, team, or agent.
			</p>
			<Button className="mt-5" onClick={onNewTopic} size="sm">
				<Plus aria-hidden="true" data-icon="inline-start" />
				New topic
			</Button>
		</div>
	);
}
