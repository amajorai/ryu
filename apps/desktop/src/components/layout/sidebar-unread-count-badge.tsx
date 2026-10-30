// Trailing unread-message count pill shared by chat and agent rows.

export function UnreadMessageCountBadge({
	conversationId,
	count,
}: {
	conversationId: string;
	count: number;
}) {
	if (count <= 0) {
		return null;
	}

	const label = `${count} unread ${count === 1 ? "message" : "messages"}`;
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
