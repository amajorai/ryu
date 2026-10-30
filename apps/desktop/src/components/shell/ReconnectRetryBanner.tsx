import {
	Alert02Icon,
	RefreshIcon,
	Tick02Icon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReconnectRetryState } from "@/src/hooks/useReconnectRetry.ts";
import { ShellBanner, type ShellBannerTone } from "./shell-banner.tsx";

type VisiblePhase = Exclude<ReconnectRetryState["phase"], "idle">;

const PHASE_ICON = {
	complete: Tick02Icon,
	error: Alert02Icon,
	offline: WifiDisconnected01Icon,
	retrying: RefreshIcon,
} satisfies Record<VisiblePhase, unknown>;

const PHASE_TONE: Record<VisiblePhase, ShellBannerTone> = {
	complete: "success",
	error: "warning",
	offline: "neutral",
	retrying: "neutral",
};

export function ReconnectRetryBanner({
	state,
}: {
	state: ReconnectRetryState;
}) {
	const tl = useLiteralMessages();
	if (state.phase === "idle") {
		return null;
	}

	const copy = {
		complete: {
			detail: tl(
				"{retriedCount, plural, one {# chat is} other {# chats are}} running again.",
				{ retriedCount: state.retriedCount }
			),
			title: "Connection restored.",
		},
		error: {
			detail: "Retry the failed chats from their tabs.",
			title: "Reconnect retry needs attention.",
		},
		offline: {
			detail: tl(
				"{candidateCount, plural, one {# active chat is} other {# active chats are}} queued for one retry when the node returns.",
				{ candidateCount: state.candidateCount }
			),
			title: "Connection lost.",
		},
		retrying: {
			detail: tl(
				"Starting one retry for {candidateCount, plural, one {# chat} other {# chats}}…",
				{ candidateCount: state.candidateCount }
			),
			title: "Connection restored.",
		},
	}[state.phase];

	return (
		<ShellBanner
			data-testid="reconnect-retry-status"
			detail={copy.detail}
			icon={<HugeiconsIcon icon={PHASE_ICON[state.phase]} />}
			title={copy.title}
			tone={PHASE_TONE[state.phase]}
		/>
	);
}
