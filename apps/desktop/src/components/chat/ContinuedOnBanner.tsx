import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	clearRnpContinued,
	workspaceErrorMessage,
} from "@/src/lib/api/continuity-workspace.ts";
import type { ContinuedOn } from "@/src/lib/continued-on.ts";

// "Continued on <computer>": shown on the source after an RNP handoff so two
// computers do not keep editing the same branch. The badge is mounted in the
// sidebar row; the banner is meant for the composer area, above the input,
// where it pauses the copy until the user takes the thread back.

export function ContinuedOnBadge({
	continuedOn,
}: {
	continuedOn: ContinuedOn;
}) {
	const tl = useLiteralMessages();
	return (
		<span
			className="type-compact max-w-24 shrink-0 truncate rounded bg-muted px-1 text-muted-foreground"
			title={tl("Continued on {nodeLabel}", {
				nodeLabel: continuedOn.nodeLabel,
			})}
		>
			on {continuedOn.nodeLabel}
		</span>
	);
}

export interface ContinuedOnBannerProps {
	continuedOn: ContinuedOn;
	conversationId: string;
	/** Called after the source cleared the marker; refresh the conversation. */
	onTakenBack: () => Promise<void> | void;
	/** The source node that holds this copy of the thread. */
	target: ApiTarget;
}

export function ContinuedOnBanner({
	continuedOn,
	conversationId,
	onTakenBack,
	target,
}: ContinuedOnBannerProps) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const takeBack = async () => {
		setPending(true);
		setError(null);
		try {
			await clearRnpContinued(target, conversationId);
			await onTakenBack();
		} catch (cause) {
			setError(workspaceErrorMessage(cause, "Could not take the thread back"));
		} finally {
			setPending(false);
		}
	};

	return (
		<div
			className="flex flex-wrap items-center gap-2 rounded-xl border border-status-warning/40 bg-status-warning/10 px-3 py-2 text-sm"
			data-testid="continued-on-banner"
			role="status"
		>
			<span className="min-w-0 flex-1">
				Continued on <strong>{continuedOn.nodeLabel}</strong>. This copy is
				paused so two computers do not edit the same branch.
			</span>
			<Button
				disabled={pending}
				onClick={() => void takeBack()}
				size="sm"
				variant="outline"
			>
				{pending ? "Taking back…" : "Take back here"}
			</Button>
			{error ? (
				<p className="w-full text-status-destructive text-xs" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
