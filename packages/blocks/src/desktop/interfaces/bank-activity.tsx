import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { useMemo } from "react";
import { agentActivity, formatCount } from "./bank-model.ts";
import { BoardAvatar } from "./board-avatar.tsx";
import { compactAge } from "./interface-renderer.ts";

/**
 * No account to show: signed out, no wallet on this host, or the wallet could
 * not be reached just now (the host keeps retrying). The renderer cannot tell
 * these apart, so the note names both causes instead of assuming the user is
 * signed out, then lists each agent's activity from the threads this device
 * has.
 */
export function BankSignedOut({
	now,
	onNewThread,
	onOpenThread,
	snapshot,
}: {
	now: number;
	onNewThread: () => void;
	onOpenThread: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const tl = useLiteralMessages();
	const rows = useMemo(() => agentActivity(snapshot), [snapshot]);
	return (
		<div className="flex flex-col gap-12" data-testid="bank-signed-out">
			<section
				aria-labelledby="bank-connect-heading"
				className="flex flex-col gap-2"
			>
				<p className="font-medium text-muted-foreground text-sm">Balance</p>
				<h2
					className="mt-1 font-semibold text-2xl text-foreground tracking-tight"
					id="bank-connect-heading"
				>
					Balance unavailable
				</h2>
				<p className="max-w-md text-muted-foreground text-sm">
					Sign in to your Ryu account from Settings to see your balance, spend,
					and statements here. If you are already signed in, your account could
					not be reached just now; it appears here as soon as it loads.
				</p>
			</section>
			<section
				aria-labelledby="bank-activity-heading"
				className="flex flex-col"
			>
				<h2
					className="border-border border-b pb-3 font-semibold text-base text-foreground"
					id="bank-activity-heading"
				>
					Agent activity
				</h2>
				{rows.length === 0 ? (
					<div className="flex flex-col items-start gap-4 py-10">
						<div className="flex flex-col gap-1">
							<p className="font-medium text-foreground text-sm">
								No agents yet
							</p>
							<p className="text-muted-foreground text-sm">
								Start a thread and its agent&apos;s activity appears here.
							</p>
						</div>
						<Button onClick={onNewThread} size="sm" type="button">
							<Plus aria-hidden="true" data-icon="inline-start" />
							New thread
						</Button>
					</div>
				) : (
					<ul className="-mx-3 flex flex-col pt-2">
						{rows.map((row) => {
							const latest = row.latest;
							const summary = tl(
								"{threads, plural, one {{threadCount} conversation} other {{threadCount} conversations}} · {messages, plural, one {{messageCount} message} other {{messageCount} messages}}",
								{
									messageCount: formatCount(row.messages),
									messages: row.messages,
									threadCount: formatCount(row.threads),
									threads: row.threads,
								}
							);
							const inner = (
								<>
									<BoardAvatar
										agent={row.agent}
										className="size-10"
										name={row.agent.name}
										size={28}
									/>
									<span className="flex min-w-0 flex-col gap-0.5">
										<span className="truncate font-medium text-foreground text-sm">
											{row.agent.name}
										</span>
										<span className="truncate text-muted-foreground text-xs">
											{summary}
										</span>
									</span>
									<span className="flex flex-col items-end gap-0.5 text-xs">
										<span
											className={
												row.working
													? "text-status-success"
													: "text-muted-foreground"
											}
										>
											{row.working ? "Working" : "Idle"}
										</span>
										<span className="text-muted-foreground tabular-nums">
											{latest ? compactAge(latest.updatedAt, now) : ""}
										</span>
									</span>
								</>
							);
							const rowClass =
								"grid w-full grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-3 py-2.5 text-left";
							return (
								<li key={row.agent.id}>
									{latest ? (
										<button
											aria-label={tl(
												"{name}: {summary}. Open latest conversation",
												{ name: row.agent.name, summary }
											)}
											className={`${rowClass} outline-none transition-colors duration-100 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none`}
											onClick={() => onOpenThread(latest.id)}
											type="button"
										>
											{inner}
										</button>
									) : (
										<div className={rowClass}>{inner}</div>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</section>
		</div>
	);
}
