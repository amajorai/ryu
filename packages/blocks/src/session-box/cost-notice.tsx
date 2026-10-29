"use client";

// The one-time computer-use cost notice, shared by the desktop and web chats.
//
// Computer use defaults to a session Box of its own. The first time for each
// person, Core refuses to start that Box until they acknowledge its hourly
// cost, and the conversation's session Box status carries the notice with the
// Gateway's live rate. This card shows it; "Allow" records the
// acknowledgement (echoing the rate that was shown, so a changed rate is
// shown again instead of being accepted blind). While the agent's computer-use
// call is held for the answer (`waiting`), allowing it starts the Box and the
// turn goes on; once that call has given up, the agent starts the Box on its
// next computer-use step. `CostNoticeAllowed` says which until the Box
// appears.

import { Button } from "@ryu/ui/components/button";
import { useId, useState } from "react";
import {
	costNoticeHeading,
	costNoticeText,
	type SessionBoxCostNotice,
} from "./wire.ts";

export interface ComputerUseCostNoticeProps {
	notice: SessionBoxCostNotice;
	/**
	 * Record the acknowledgement of `rate`; throws with a readable message.
	 * On success the caller replaces the card (with `CostNoticeAllowed`).
	 */
	onAcknowledge: (ratePerHourMicroUsd: number) => Promise<void>;
}

export function ComputerUseCostNotice({
	notice,
	onAcknowledge,
}: ComputerUseCostNoticeProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const titleId = useId();
	const rate = notice.ratePerHourMicroUsd;

	const allow = async () => {
		if (rate === null || busy) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onAcknowledge(rate);
		} catch (failure) {
			setError(
				failure instanceof Error
					? failure.message
					: "The acknowledgement could not be saved."
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section
			aria-labelledby={titleId}
			className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs"
			data-testid="computer-use-cost-notice"
		>
			<h3 className="font-medium text-sm" id={titleId}>
				{costNoticeHeading(notice)}
			</h3>
			<p className="text-muted-foreground">{costNoticeText(notice)}</p>
			{error ? (
				<p className="text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			<div className="flex items-center gap-2">
				<Button
					disabled={rate === null || busy}
					onClick={allow}
					size="sm"
					type="button"
				>
					{busy ? "Saving" : "Allow"}
				</Button>
				{rate === null ? (
					<span className="text-muted-foreground">
						Allow is available once the rate can be read.
					</span>
				) : null}
			</div>
		</section>
	);
}

export interface CostNoticeAllowedProps {
	/**
	 * The agent's call was held for the answer when it was given, so the Box
	 * starts on its own and the turn goes on.
	 */
	resumes: boolean;
}

/** Shown after "Allow" until the Box appears. */
export function CostNoticeAllowed({ resumes }: CostNoticeAllowedProps) {
	return (
		<p
			className="rounded-md border px-3 py-2 text-muted-foreground text-xs"
			data-testid="computer-use-cost-notice-allowed"
			role="status"
		>
			{resumes
				? "Allowed. The Box is starting and the agent continues."
				: "Allowed. Ask the agent to continue and it starts the Box."}
		</p>
	);
}
