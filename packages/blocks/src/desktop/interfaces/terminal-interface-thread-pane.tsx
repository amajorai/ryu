import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import type {
	InterfaceSnapshot,
	InterfaceThread,
	ThreadStatus,
} from "@ryuhq/protocol/interfaces";
import type { ReactNode } from "react";
import { threadOwnerLabel, threadTitle } from "./terminal-model.ts";
import { TerminalStatus } from "./terminal-output.tsx";

/** The open thread beside the scrollback, in the host's conversation surface. */
export function TerminalThreadPane({
	activeStatus,
	activeThread,
	closeThread,
	focusInput,
	snapshot,
	threadView,
}: {
	activeStatus: ThreadStatus | null;
	activeThread: InterfaceThread | undefined;
	closeThread: (fromCommand: boolean) => boolean;
	focusInput: () => void;
	snapshot: InterfaceSnapshot;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	return (
		<section
			aria-label={tl("Thread: {title}", { title: threadTitle(activeThread) })}
			className="flex @3xl/terminal:h-auto @md/terminal:h-1/2 h-2/3 min-h-0 @3xl/terminal:w-[min(58%,56rem)] shrink-0 flex-col border-border border-t @3xl/terminal:border-t-0 @3xl/terminal:border-l"
		>
			<header className="flex h-10 shrink-0 items-center gap-3 border-border border-b bg-background pr-2 pl-4">
				<h2 className="min-w-0 truncate font-medium">
					{threadTitle(activeThread)}
				</h2>
				{activeThread && activeStatus ? (
					<p className="shrink-0 whitespace-nowrap text-muted-foreground">
						<span className="@md/terminal:inline hidden">
							{threadOwnerLabel(snapshot, activeThread)} ·{" "}
						</span>
						<TerminalStatus status={activeStatus} />
					</p>
				) : null}
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								aria-label="Close thread"
								className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
								onClick={() => {
									closeThread(false);
									focusInput();
								}}
								size="icon-sm"
								variant="ghost"
							>
								<HugeiconsIcon
									aria-hidden="true"
									className="size-4"
									icon={Cancel01Icon}
								/>
							</Button>
						}
					/>
					<TooltipContent side="bottom">
						Close thread{" "}
						<Kbd className="in-data-[slot=tooltip-content]:bg-background in-data-[slot=tooltip-content]:text-foreground dark:in-data-[slot=tooltip-content]:bg-background">
							Esc
						</Kbd>
					</TooltipContent>
				</Tooltip>
			</header>
			<div className="min-h-0 flex-1 overflow-hidden font-sans text-sm leading-normal">
				{threadView}
			</div>
		</section>
	);
}
