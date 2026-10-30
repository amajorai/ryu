import { ComputerTerminal01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { threadTitle } from "./terminal-model.ts";

/** The window-style tab strip above the terminal, with the connection state. */
export function TerminalTitleBar({
	activeThread,
	loading,
	threadOpen,
}: {
	activeThread: InterfaceThread | undefined;
	loading: boolean;
	threadOpen: boolean;
}) {
	const tl = useLiteralMessages();
	return (
		<div
			className="flex h-10 shrink-0 items-end gap-1 border-border border-b bg-muted/50 px-2 font-sans text-detail"
			role="presentation"
		>
			<p className="flex h-8 min-w-0 max-w-80 items-center gap-2 rounded-t-lg border border-border border-b-0 bg-background px-3 text-foreground">
				<HugeiconsIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
					icon={ComputerTerminal01Icon}
				/>
				<span className="truncate">
					{tl("you@ryu: {path}", {
						path: threadOpen ? threadTitle(activeThread) : "~",
					})}
				</span>
			</p>
			<p className="mb-2 ml-auto @md/terminal:flex hidden shrink-0 items-center gap-1.5 pr-1 text-muted-foreground">
				<span
					aria-hidden="true"
					className={cn(
						"size-1.5 rounded-full",
						loading ? "bg-muted-foreground/40" : "bg-success"
					)}
				/>
				{loading ? "connecting" : "connected"}
			</p>
		</div>
	);
}
