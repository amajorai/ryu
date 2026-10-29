import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { LayoutList, Plus, SquarePen, X } from "lucide-react";
import type { ReactNode } from "react";
import type { Ticket } from "./tickets-model.ts";
import { TicketStatusMark } from "./tickets-parts.tsx";

const TAB =
	"group/tab relative flex h-full min-w-0 shrink-0 items-center border-border border-r text-[13px] transition-colors";
const TAB_IDLE =
	"text-muted-foreground hover:bg-muted/60 hover:text-foreground";
const TAB_CURRENT = "bg-background text-foreground";

function TabShell({
	children,
	closeLabel,
	current,
	onClose,
}: {
	children: ReactNode;
	closeLabel: string | null;
	current: boolean;
	onClose: (() => void) | null;
}) {
	return (
		<li className={cn(TAB, current ? TAB_CURRENT : TAB_IDLE, "max-w-60")}>
			{children}
			{onClose && closeLabel ? (
				<button
					aria-label={closeLabel}
					className={cn(
						"me-1.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-[opacity,background-color] hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
						current ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
					)}
					onClick={onClose}
					type="button"
				>
					<X aria-hidden="true" className="size-3.5" />
				</button>
			) : null}
		</li>
	);
}

const TAB_BUTTON =
	"flex h-full min-w-0 items-center gap-2 ps-3 pe-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * Zendesk's tab strip: the views home, one tab per ticket you have opened,
 * the draft tab while you write a new ticket, and the New ticket button.
 */
export function TicketsTabs({
	activeId,
	composing,
	compact,
	draftCurrent,
	onCloseDraft,
	onCloseTab,
	onNewTicket,
	onOpenTab,
	onShowDraft,
	onShowViews,
	tabs,
	viewsCurrent,
}: {
	/** The ticket on screen, when one is. */
	activeId: string | null;
	composing: boolean;
	/** Narrow widths keep only the current ticket's tab. */
	compact: boolean;
	draftCurrent: boolean;
	onCloseDraft: () => void;
	onCloseTab: (ticketId: string) => void;
	onNewTicket: () => void;
	onOpenTab: (ticketId: string) => void;
	onShowDraft: () => void;
	onShowViews: () => void;
	tabs: Ticket[];
	viewsCurrent: boolean;
}) {
	const tl = useLiteralMessages();
	const shown = compact ? tabs.filter((tab) => tab.id === activeId) : tabs;
	return (
		<div
			className="flex h-10 shrink-0 items-stretch bg-muted/40 shadow-[inset_0_-1px_0_var(--border)]"
			data-testid="tickets-tabs"
		>
			<nav aria-label="Ticket tabs" className="flex min-w-0 flex-1">
				<ul className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none]">
					<TabShell closeLabel={null} current={viewsCurrent} onClose={null}>
						<button
							aria-current={viewsCurrent ? "page" : undefined}
							className={cn(TAB_BUTTON, "pe-3")}
							onClick={onShowViews}
							type="button"
						>
							<LayoutList aria-hidden="true" className="size-4 shrink-0" />
							<span className={cn(compact && "sr-only")}>Views</span>
						</button>
					</TabShell>
					{shown.map((tab) => {
						const current = tab.id === activeId;
						return (
							<TabShell
								closeLabel={tl("Close tab #{number}", {
									number: String(tab.number),
								})}
								current={current}
								key={tab.id}
								onClose={() => onCloseTab(tab.id)}
							>
								<button
									aria-current={current ? "page" : undefined}
									className={TAB_BUTTON}
									data-testid={`tickets-tab-${tab.id}`}
									onClick={() => onOpenTab(tab.id)}
									title={tab.thread.title}
									type="button"
								>
									<TicketStatusMark status={tab.status} />
									<span className="truncate">{tab.thread.title}</span>
									<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
										#{tab.number}
									</span>
								</button>
							</TabShell>
						);
					})}
					{composing ? (
						<TabShell
							closeLabel="Discard new ticket"
							current={draftCurrent}
							onClose={onCloseDraft}
						>
							<button
								aria-current={draftCurrent ? "page" : undefined}
								className={TAB_BUTTON}
								data-testid="tickets-tab-draft"
								onClick={onShowDraft}
								type="button"
							>
								<SquarePen aria-hidden="true" className="size-4 shrink-0" />
								<span className="truncate">New ticket</span>
							</button>
						</TabShell>
					) : null}
				</ul>
			</nav>
			<div className="flex shrink-0 items-center px-3">
				<Button
					aria-label="New ticket"
					data-testid="tickets-new"
					onClick={onNewTicket}
					size="xs"
					title="New ticket (C)"
					type="button"
					variant="default"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className={cn(compact && "sr-only")}>New ticket</span>
				</Button>
			</div>
		</div>
	);
}
