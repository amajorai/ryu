/* @jsxImportSource @opentui/react */
// Shared error surface for a tab's content area. Renders the message with an
// optional retry hint. For transient action failures prefer useToast().notify;
// use ErrorView when the whole tab failed to load and there is nothing else to show.
// Callers pass the message through humanizeError (core/native-errors.ts) so raw
// socket codes and zod issue dumps never reach the frame.

import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";

export const RETRY_HINT = "Press r to retry";

/** The hint line to show: an explicit hint wins; otherwise the retry hint only
 * when the caller actually binds r (onRetry). */
export function errorViewHint({
	hint,
	onRetry,
}: {
	hint?: string;
	onRetry?: boolean;
}): string | null {
	if (hint) {
		return hint;
	}
	return onRetry ? RETRY_HINT : null;
}

export function ErrorView({
	message,
	hint,
	onRetry = false,
}: {
	hint?: string;
	message: string;
	/** True when the surface binds r to reload; only then is the hint shown. */
	onRetry?: boolean;
}) {
	const theme = useTheme();
	const line = errorViewHint({ hint, onRetry });
	return (
		<box flexDirection="column" gap={1} paddingLeft={1} paddingTop={1}>
			<StatusMessage variant="error">{message}</StatusMessage>
			{line ? <text fg={theme.colors.mutedForeground}>{line}</text> : null}
		</box>
	);
}
