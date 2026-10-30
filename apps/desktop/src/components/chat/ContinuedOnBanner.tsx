import { ComputerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { ShellBanner } from "@/src/components/shell/shell-banner.tsx";
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
			className="max-w-24 shrink-0 truncate text-muted-foreground/70 text-xs"
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
	const tl = useLiteralMessages();
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
		<>
			{/* The shell's one banner pattern: a muted icon, one sentence (the
			    reason reads in full on hover and to screen readers) and one
			    action. */}
			<ShellBanner
				action={
					<Button
						disabled={pending}
						onClick={() => void takeBack()}
						size="sm"
						variant="ghost"
					>
						{pending ? "Taking back…" : "Take back here"}
					</Button>
				}
				data-testid="continued-on-banner"
				detail="This copy is paused so two computers do not edit the same branch."
				icon={<HugeiconsIcon icon={ComputerIcon} />}
				title={tl("Continued on {nodeLabel}.", {
					nodeLabel: continuedOn.nodeLabel,
				})}
			/>
			{error ? (
				<p
					className="text-(length:--text-detail) px-4 py-1 text-status-destructive"
					role="alert"
				>
					{error}
				</p>
			) : null}
		</>
	);
}
