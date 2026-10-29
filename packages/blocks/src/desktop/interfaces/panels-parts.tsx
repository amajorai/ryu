import { Button } from "@ryu/ui/components/button.tsx";
import {
	ToggleGroup,
	ToggleGroupItem,
} from "@ryu/ui/components/toggle-group.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { FolderClosed, House, MessageSquare, SquarePen } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { BoardStatusDot } from "./board-status.tsx";
import {
	isPanelsView,
	PANELS_VIEW_LABELS,
	PANELS_VIEWS,
	type PanelsView,
} from "./panels-model.ts";

export const PANELS_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/** The current time, refreshed each half minute while the page is visible. */
export function usePanelsClock(intervalMs = 30_000): Date {
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const tick = () => {
			if (document.visibilityState !== "hidden") {
				setNow(new Date());
			}
		};
		const timer = setInterval(tick, intervalMs);
		document.addEventListener("visibilitychange", tick);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", tick);
		};
	}, [intervalMs]);
	return now;
}

const VIEW_ICONS: Record<PanelsView, typeof House> = {
	chat: MessageSquare,
	home: House,
	projects: FolderClosed,
};

/** Statuses worth a mark in the sidebar's recent list. */
function showsMark(thread: InterfaceThread): boolean {
	const status = threadStatus(thread);
	return (
		status === "attention" || status === "your-turn" || status === "working"
	);
}

/**
 * The left rail: New chat, the three views, and the recent conversations,
 * like the reference assistant's sidebar. Hidden below `md`, where the
 * segmented control in {@link PanelsTopBar} takes over.
 */
export function PanelsSidebar({
	activeThreadId,
	onNewChat,
	onOpenThread,
	onSelectView,
	recent,
	view,
}: {
	activeThreadId: string | null;
	onNewChat: () => void;
	onOpenThread: (threadId: string) => void;
	onSelectView: (view: PanelsView) => void;
	recent: InterfaceThread[];
	view: PanelsView;
}) {
	return (
		<aside
			aria-label="Panels"
			className="hidden w-60 shrink-0 flex-col border-border border-r bg-background md:flex"
			data-testid="panels-sidebar"
		>
			<div className="flex flex-col gap-1 px-3 pt-3">
				<button
					className="flex h-8 items-center gap-2.5 rounded-md px-2 font-medium text-foreground text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
					onClick={onNewChat}
					type="button"
				>
					<SquarePen aria-hidden="true" className="size-4" />
					New chat
				</button>
			</div>
			<nav aria-label="Views" className="flex flex-col gap-px px-3 pt-2">
				{PANELS_VIEWS.map((option) => {
					const Icon = VIEW_ICONS[option];
					const current = option === view;
					return (
						<button
							aria-current={current ? "page" : undefined}
							className={cn(
								"flex h-8 items-center gap-2.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
								current
									? "bg-muted font-medium text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
							)}
							data-view={option}
							key={option}
							onClick={() => onSelectView(option)}
							type="button"
						>
							<Icon aria-hidden="true" className="size-4" />
							{PANELS_VIEW_LABELS[option]}
						</button>
					);
				})}
			</nav>
			{recent.length > 0 ? (
				<section
					aria-labelledby="panels-recent-heading"
					className="flex min-h-0 flex-1 flex-col pt-6"
				>
					<h2
						className="px-5 pb-1 font-medium text-muted-foreground text-xs"
						id="panels-recent-heading"
					>
						Recent
					</h2>
					<ul className="flex min-h-0 flex-col gap-px overflow-y-auto px-3 pb-3">
						{recent.map((thread) => {
							const current = thread.id === activeThreadId;
							return (
								<li key={thread.id}>
									<button
										aria-current={current ? "true" : undefined}
										className={cn(
											"flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
											current
												? "bg-muted text-foreground"
												: "text-foreground/80 hover:bg-muted/60 hover:text-foreground"
										)}
										onClick={() => onOpenThread(thread.id)}
										title={thread.title}
										type="button"
									>
										<span className="min-w-0 flex-1 truncate">
											{thread.title}
										</span>
										<span className="flex w-2 shrink-0 justify-center">
											{showsMark(thread) ? (
												<BoardStatusDot status={threadStatus(thread)} />
											) : null}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				</section>
			) : null}
		</aside>
	);
}

/** Below `md`: the three views as a segmented control, plus New chat. */
export function PanelsTopBar({
	onNewChat,
	onSelectView,
	view,
}: {
	onNewChat: () => void;
	onSelectView: (view: PanelsView) => void;
	view: PanelsView;
}) {
	return (
		<header className="flex h-12 shrink-0 items-center justify-between gap-2 border-border border-b bg-background px-4 md:hidden">
			<ToggleGroup
				appearance="segmented"
				aria-label="Views"
				multiple={false}
				onValueChange={(values: string[]) => {
					const next = values[0];
					if (isPanelsView(next)) {
						onSelectView(next);
					}
				}}
				spacing={0}
				value={[view]}
			>
				{PANELS_VIEWS.map((option) => (
					<ToggleGroupItem
						className="px-3"
						density="segmented"
						key={option}
						value={option}
					>
						{PANELS_VIEW_LABELS[option]}
					</ToggleGroupItem>
				))}
			</ToggleGroup>
			<Button
				aria-label="New chat"
				onClick={onNewChat}
				size="icon-sm"
				title="New chat"
				type="button"
				variant="ghost"
			>
				<SquarePen aria-hidden="true" />
			</Button>
		</header>
	);
}

/** A page title block shared by Projects and the empty Chat page. */
export function PanelsPageHeader({
	action,
	description,
	title,
}: {
	action?: ReactNode;
	description: string;
	title: string;
}) {
	return (
		<header className="flex items-end justify-between gap-4">
			<div className="flex min-w-0 flex-col gap-1">
				<h1 className="font-semibold text-2xl text-foreground tracking-tight">
					{title}
				</h1>
				<p className="text-muted-foreground text-sm">{description}</p>
			</div>
			{action}
		</header>
	);
}

export function threadById(
	snapshot: InterfaceSnapshot,
	threadId: string | null
): InterfaceThread | undefined {
	return threadId
		? snapshot.threads.find((thread) => thread.id === threadId)
		: undefined;
}
