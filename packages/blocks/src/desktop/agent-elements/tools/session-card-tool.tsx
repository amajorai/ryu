import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";
import {
	requestOpenConversation,
	type SessionCardStatus,
	sessionCardModel,
} from "./session-card-tool-logic.ts";

const STATUS_LABEL = {
	starting: "Starting",
	running: "Running",
	done: "Done",
	failed: "Failed",
} satisfies Record<SessionCardStatus, string>;

const STATUS_DOT = {
	starting: "bg-muted-foreground/50",
	running: "bg-primary motion-safe:animate-pulse",
	done: "bg-success",
	failed: "bg-destructive",
} satisfies Record<SessionCardStatus, string>;

/**
 * A session the main thread spawned or messaged, shown inline in the main
 * thread's transcript: its title, the bot working on it, status, the latest
 * line, and a way to open it. Sessions are not sidebar rows; this card (and the
 * main thread's Sessions panel) is how the user reaches them.
 */
export const SessionCardTool = memo(function SessionCardTool({
	part,
}: {
	part: {
		errorText?: unknown;
		input?: unknown;
		output?: unknown;
		state?: string;
		toolName?: string;
		type?: string;
	};
}) {
	const model = sessionCardModel(part);
	if (!model) {
		return null;
	}
	const { threadId } = model;
	return (
		<div
			className="flex items-start gap-3 rounded-xl border border-border px-3 py-2"
			data-testid="session-card"
		>
			<span
				aria-hidden="true"
				className={cn(
					"mt-1.5 size-2 shrink-0 rounded-full",
					STATUS_DOT[model.status]
				)}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<p className="truncate font-medium text-sm" title={model.title}>
						{model.title}
					</p>
					<span className="shrink-0 text-muted-foreground text-xs">
						{STATUS_LABEL[model.status]}
						{model.agentId ? ` · ${model.agentId}` : ""}
					</span>
				</div>
				{model.latest ? (
					<p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
						{model.latest}
					</p>
				) : null}
			</div>
			{threadId ? (
				<Button
					onClick={() =>
						requestOpenConversation({
							conversationId: threadId,
							title: model.title,
						})
					}
					size="xs"
					variant="outline"
				>
					Open session
				</Button>
			) : null}
		</div>
	);
});
