import { CloudServerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useSystemStatusContext } from "@/src/contexts/SystemStatusContext.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";

/** Read-only connection state for Bot. Node selection stays a Build concern. */
export function BotConnectionBadge() {
	const activeNode = useActiveNode();
	const tl = useLiteralMessages();
	const { coreReachable, gatewayReachable, loading } = useSystemStatusContext();
	const connected = coreReachable && gatewayReachable;
	const statusLabel = loading
		? "Connecting"
		: connected
			? "Connected"
			: "Reconnecting";
	const dotClass = loading
		? "bg-muted-foreground/40"
		: connected
			? "bg-success"
			: "bg-warning";

	return (
		<div
			aria-label={tl("Ryu Cloud managed workspace: {statusLabel}", {
				statusLabel,
			})}
			className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5"
			data-testid="bot-connection-status"
		>
			<span className="relative inline-flex size-4 shrink-0 items-center justify-center">
				<HugeiconsIcon
					className="size-4 text-muted-foreground"
					icon={CloudServerIcon}
					size={16}
				/>
				<span
					className={`absolute -right-0.5 -bottom-0.5 size-2 rounded-full border-2 border-sidebar ${dotClass}`}
				/>
			</span>
			<span className="min-w-0 truncate">
				<span className="block truncate font-medium text-sm">Ryu Cloud</span>
				<span className="block truncate text-detail text-muted-foreground">
					{activeNode.managed ? statusLabel : "Preparing managed workspace"}
				</span>
			</span>
		</div>
	);
}
