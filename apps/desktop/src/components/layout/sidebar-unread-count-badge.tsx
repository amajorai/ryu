// Trailing unread-message count pill shared by chat and agent rows.

import { useLiteralMessages } from "@ryu/i18n/react";

export function UnreadMessageCountBadge({
	conversationId,
	count,
}: {
	conversationId: string;
	count: number;
}) {
	const tl = useLiteralMessages();
	if (count <= 0) {
		return null;
	}

	const label = tl(
		"{count, plural, one {# unread message} other {# unread messages}}",
		{ count }
	);
	return (
		<span
			aria-atomic="true"
			aria-label={label}
			className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-foreground px-1 font-medium text-background text-xs tabular-nums leading-none"
			data-testid={`sidebar-unread-count-${conversationId}`}
			role="status"
			title={label}
		>
			{count > 99 ? "99+" : count}
		</span>
	);
}
