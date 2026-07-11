/* @jsxImportSource @opentui/react */
// Shared error surface for a tab's content area. Renders the message with an
// optional retry hint. For transient action failures prefer useToast().notify;
// use ErrorView when the whole tab failed to load and there is nothing else to show.

import { StatusMessage } from "@/components/ui/status-message.tsx";
import { useTheme } from "@/components/ui/theme-provider.tsx";

export function ErrorView({
	message,
	hint = "Press r to retry",
}: {
	message: string;
	hint?: string;
}) {
	const theme = useTheme();
	return (
		<box flexDirection="column" gap={1} paddingLeft={1} paddingTop={1}>
			<StatusMessage variant="error">{message}</StatusMessage>
			{hint ? <text fg={theme.colors.mutedForeground}>{hint}</text> : null}
		</box>
	);
}
