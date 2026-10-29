import { useLiteralMessages } from "@ryu/i18n/react";
import type { ReconnectRetryState } from "@/src/hooks/useReconnectRetry.ts";

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
			title: "Connection restored",
		},
		error: {
			detail:
				"Ryu kept the failed candidates bounded; you can retry them from their chat tabs.",
			title: "Reconnect retry needs attention",
		},
		offline: {
			detail: tl(
				"{candidateCount, plural, one {# active chat is} other {# active chats are}} queued for one retry when the node returns.",
				{ candidateCount: state.candidateCount }
			),
			title: "Connection lost",
		},
		retrying: {
			detail: tl(
				"Starting one retry for {candidateCount, plural, one {# chat} other {# chats}}…",
				{ candidateCount: state.candidateCount }
			),
			title: "Connection restored",
		},
	}[state.phase];

	return (
		<output
			aria-live="polite"
			className="flex w-full items-center gap-3 border-border border-b bg-primary/5 px-4 py-2 text-sm"
			data-testid="reconnect-retry-status"
		>
			<span className="font-medium">{copy.title}</span>
			<span className="text-muted-foreground">{copy.detail}</span>
		</output>
	);
}
