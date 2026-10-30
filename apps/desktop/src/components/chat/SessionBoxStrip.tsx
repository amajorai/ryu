// apps/desktop/src/components/chat/SessionBoxStrip.tsx
//
// The composer's view of a normal chat's session Box. Computer use, the
// browser and worker threads start a Box of their own mid-conversation,
// so a chat that never chose a cloud environment can still be paying for one.
// While that Box runs, the strip shows its cost chip and a "View screen"
// action; the low-credit warning and the out-of-credit stop banner show here
// too, so they are seen without opening the Box screen tab. Locked cloud chats
// show the same pieces in CloudTaskPanel instead.
//
// The first time computer use would start a Box for this person, Core holds
// it back and the status carries a cost notice; the strip shows it with the
// Box's live hourly rate until they allow it.

import { MonitorDotIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CLOUD_TASKS_BOX_BACKEND_FLAG } from "@ryu/auth/lib/feature-flags";
import {
	ComputerUseCostNotice,
	CostNoticeAllowed,
} from "@ryu/blocks/session-box/cost-notice.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { useFeatureFlag } from "@/src/hooks/useFeatureFlag.ts";
import {
	isLiveSessionBox,
	openSessionBoxScreen,
	useSessionBox,
} from "@/src/hooks/useSessionBox.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	acknowledgeSessionBoxCost,
	type SessionBoxStatus,
	type SessionBoxView,
	sessionBoxErrorMessage,
} from "@/src/lib/api/session-box.ts";
import { BoxCostChip, BoxCreditBanner } from "./BoxCostChip.tsx";

/** The strip for one Box. Renders nothing while the Box is neither live nor stopped for money. */
export function SessionBoxSummary({
	box,
	conversationId,
}: {
	box: SessionBoxView;
	conversationId: string;
}) {
	const live = isLiveSessionBox(box);
	const banner = <BoxCreditBanner box={box} />;
	if (!live) {
		// A parked or stopped Box costs nothing; only an exhaustion banner stays.
		return banner;
	}
	return (
		<div
			className="flex w-full min-w-0 flex-col gap-1"
			data-testid="session-box-strip"
		>
			<div className="flex min-w-0 items-center gap-1">
				<span className="text-muted-foreground text-xs">Session Box</span>
				<BoxCostChip box={box} />
				<Button
					disabled={box.state !== "ready"}
					onClick={() => openSessionBoxScreen(conversationId)}
					size="sm"
					type="button"
					variant="ghost"
				>
					<HugeiconsIcon className="size-3.5" icon={MonitorDotIcon} />
					View screen
				</Button>
			</div>
			{banner}
		</div>
	);
}

/**
 * The strip's content for one status: the one-time cost notice while a Box
 * waits for it (then the "allowed" line until the Box appears), and the
 * running Box's summary.
 */
export function SessionBoxStripContent({
	conversationId,
	refetch,
	status,
	target,
}: {
	conversationId: string;
	refetch: () => Promise<unknown>;
	status: SessionBoxStatus | null | undefined;
	target: ApiTarget;
}) {
	// Where "Allow" was given, and whether a held call then starts the Box.
	const [allowed, setAllowed] = useState<{
		conversationId: string;
		resumes: boolean;
	} | null>(null);
	const acknowledge = async (rate: number) => {
		const resumes = status?.costNotice?.waiting === true;
		try {
			await acknowledgeSessionBoxCost(target, conversationId, rate);
			setAllowed({ conversationId, resumes });
		} catch (error) {
			throw new Error(sessionBoxErrorMessage(error));
		} finally {
			await refetch();
		}
	};
	let notice: React.ReactNode = null;
	if (status?.costNotice) {
		notice = (
			<ComputerUseCostNotice
				notice={status.costNotice}
				onAcknowledge={acknowledge}
			/>
		);
	} else if (allowed?.conversationId === conversationId && !status?.box) {
		notice = <CostNoticeAllowed resumes={allowed.resumes} />;
	}
	const summary = status?.box ? (
		<SessionBoxSummary box={status.box} conversationId={conversationId} />
	) : null;
	if (!(notice || summary)) {
		return null;
	}
	return (
		<div className="flex w-full min-w-0 flex-col gap-1">
			{notice}
			{summary}
		</div>
	);
}

/** Polls the conversation's session Box while the Box rollout is on. */
export function SessionBoxStrip({
	conversationId,
	target,
}: {
	conversationId: string;
	target: ApiTarget;
}) {
	const enabled = useFeatureFlag(CLOUD_TASKS_BOX_BACKEND_FLAG);
	const { data: status, refetch } = useSessionBox(
		target,
		conversationId,
		enabled
	);
	if (!enabled) {
		return null;
	}
	return (
		<SessionBoxStripContent
			conversationId={conversationId}
			refetch={refetch}
			status={status}
			target={target}
		/>
	);
}
