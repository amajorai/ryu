import { StarIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { usePrimaryBot } from "@/src/hooks/usePrimaryBot.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";

/** Native button semantics provide Enter/Space activation and a visible focus ring. */
export function PrimaryBotControl({
	agentId,
	agentName,
	target,
}: {
	agentId: string;
	agentName: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const primary = usePrimaryBot(target);
	const selected = primary.data?.agentId === agentId;
	const effective = primary.data?.effectiveAgentId === agentId;
	return (
		<div className="flex flex-col items-start gap-1">
			<Button
				aria-label={
					selected
						? tl("Clear {agentName} as primary bot", { agentName })
						: tl("Make {agentName} primary bot", { agentName })
				}
				aria-pressed={selected}
				disabled={!primary.data || primary.mutation.isPending}
				onClick={() => primary.mutation.mutate(selected ? null : agentId)}
				size="sm"
				variant="ghost"
			>
				<HugeiconsIcon
					aria-hidden="true"
					className={
						effective
							? "fill-warning text-status-warning"
							: "text-muted-foreground"
					}
					fill={effective ? "currentColor" : "none"}
					icon={StarIcon}
					size={16}
				/>
				{selected
					? "Primary bot"
					: effective
						? "Primary bot (default)"
						: "Make primary"}
			</Button>
			{primary.mutation.error ? (
				<span className="text-destructive text-xs" role="alert">
					{primary.mutation.error.message}
				</span>
			) : null}
		</div>
	);
}
