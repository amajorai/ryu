import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceGroup } from "@ryuhq/protocol/interfaces";
import {
	Hourglass,
	Inbox,
	type LucideIcon,
	Mails,
	Pencil,
	Send,
	Star,
	Tag,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	MAIL_FOLDERS,
	type MailFolderCounts,
	type MailFolderId,
	type MailView,
	mailViewsEqual,
} from "./mail-model.ts";

const FOLDER_ICONS: Record<MailFolderId, LucideIcon> = {
	all: Mails,
	inbox: Inbox,
	sent: Send,
	starred: Star,
	working: Hourglass,
};

/** Folders that show a count; All mail never does, as in Gmail. */
const COUNTED: ReadonlySet<MailFolderId> = new Set([
	"inbox",
	"starred",
	"working",
	"sent",
]);

const NAV_ITEM_CLASS =
	"group/nav relative flex h-8 w-full items-center gap-4 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset";

function NavItem({
	collapsed,
	count,
	countStrong,
	icon: Icon,
	label,
	onSelect,
	selected,
}: {
	collapsed: boolean;
	count: number | null;
	countStrong: boolean;
	icon: LucideIcon;
	label: string;
	onSelect: () => void;
	selected: boolean;
}) {
	const showCount = count !== null && count > 0;
	const spoken = showCount ? `${label}, ${count}` : label;
	const button = (
		<button
			aria-current={selected ? "page" : undefined}
			aria-label={collapsed ? spoken : undefined}
			className={cn(
				NAV_ITEM_CLASS,
				collapsed
					? "mx-auto w-14 justify-center rounded-full px-0"
					: "rounded-r-full pr-3 pl-6",
				selected
					? "bg-primary/15 font-semibold text-foreground"
					: "text-foreground/85 hover:bg-foreground/6"
			)}
			data-nav-item={label}
			onClick={onSelect}
			type="button"
		>
			<Icon
				aria-hidden="true"
				className={cn(
					"size-4.5 shrink-0",
					selected ? "text-foreground" : "text-foreground/70"
				)}
				strokeWidth={selected ? 2.25 : 1.75}
			/>
			{collapsed ? null : (
				<>
					<span className="min-w-0 flex-1 truncate">{label}</span>
					{showCount ? (
						<span
							className={cn(
								"shrink-0 text-xs tabular-nums",
								countStrong ? "font-semibold text-foreground" : "font-normal",
								!(countStrong || selected) && "text-muted-foreground"
							)}
						>
							{count}
						</span>
					) : null}
				</>
			)}
			{collapsed && showCount && countStrong ? (
				<span
					aria-hidden="true"
					className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary ring-2 ring-sidebar"
				/>
			) : null}
		</button>
	);
	if (!collapsed) {
		return <li>{button}</li>;
	}
	return (
		<li>
			<Tooltip>
				<TooltipTrigger render={button} />
				<TooltipContent side="right">{spoken}</TooltipContent>
			</Tooltip>
		</li>
	);
}

function ComposeButton({
	collapsed,
	disabled,
	onCompose,
}: {
	collapsed: boolean;
	disabled: boolean;
	onCompose: () => void;
}) {
	const button = (
		<button
			aria-keyshortcuts="c"
			aria-label={collapsed ? "Compose" : undefined}
			className={cn(
				"flex h-14 items-center gap-3 rounded-2xl bg-primary/15 font-medium text-foreground text-sm outline-none transition-shadow",
				"hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/60 active:shadow-sm",
				"disabled:pointer-events-none disabled:opacity-50",
				collapsed ? "mx-auto w-14 justify-center" : "mr-auto pr-6 pl-4"
			)}
			data-testid="mail-compose-button"
			disabled={disabled}
			onClick={onCompose}
			type="button"
		>
			<Pencil aria-hidden="true" className="size-5" strokeWidth={1.75} />
			{collapsed ? null : "Compose"}
		</button>
	);
	if (!collapsed) {
		return button;
	}
	return (
		<Tooltip>
			<TooltipTrigger render={button} />
			<TooltipContent side="right">Compose</TooltipContent>
		</Tooltip>
	);
}

function NavSkeleton() {
	return (
		<div aria-hidden="true" className="flex flex-col gap-3 pt-2 pr-4 pl-6">
			{["w-24", "w-20", "w-24", "w-16", "w-20"].map((width) => (
				<Skeleton className={cn("h-4", width)} key={width} radius="pill" />
			))}
		</div>
	);
}

/**
 * Gmail's left navigation: Compose, the system folders with counts, then
 * Labels (teams and projects). Collapsed, it becomes Gmail's icon rail.
 */
export function MailNav({
	collapsed,
	composeDisabled,
	counts,
	labelUnread,
	labels,
	loading,
	onCompose,
	onSelect,
	view,
}: {
	collapsed: boolean;
	composeDisabled: boolean;
	counts: MailFolderCounts;
	labelUnread: Map<string, number>;
	labels: InterfaceGroup[];
	loading: boolean;
	onCompose: () => void;
	onSelect: (view: MailView) => void;
	/** Null while a search runs across all mail: no folder is current. */
	view: MailView | null;
}): ReactNode {
	return (
		<nav
			aria-label="Mail folders"
			className={cn(
				"flex min-h-0 shrink-0 flex-col gap-4 overflow-y-auto pb-4",
				collapsed ? "w-[72px] items-stretch" : "w-64 pr-4"
			)}
			data-collapsed={collapsed ? "" : undefined}
			data-testid="mail-nav"
		>
			<div className={cn("pt-2", collapsed ? "px-2" : "pl-2")}>
				<ComposeButton
					collapsed={collapsed}
					disabled={composeDisabled}
					onCompose={onCompose}
				/>
			</div>
			{loading ? (
				<NavSkeleton />
			) : (
				<ul className={cn("flex flex-col", collapsed && "gap-1 px-2")}>
					{MAIL_FOLDERS.map((folder) => {
						const folderView: MailView = { id: folder.id, kind: "folder" };
						return (
							<NavItem
								collapsed={collapsed}
								count={COUNTED.has(folder.id) ? counts[folder.id] : null}
								countStrong={folder.id === "inbox"}
								icon={FOLDER_ICONS[folder.id]}
								key={folder.id}
								label={folder.label}
								onSelect={() => onSelect(folderView)}
								selected={view !== null && mailViewsEqual(view, folderView)}
							/>
						);
					})}
				</ul>
			)}
			{labels.length > 0 && !loading ? (
				<section aria-labelledby="mail-labels-heading" className="pt-2">
					<h2
						className={cn(
							"flex h-10 items-center pl-6 font-medium text-base text-foreground",
							collapsed && "sr-only"
						)}
						id="mail-labels-heading"
					>
						Labels
					</h2>
					<ul className={cn("flex flex-col", collapsed && "gap-1 px-2")}>
						{labels.map((label) => {
							const labelView: MailView = { id: label.id, kind: "label" };
							return (
								<NavItem
									collapsed={collapsed}
									count={labelUnread.get(label.id) ?? null}
									countStrong
									icon={Tag}
									key={label.id}
									label={label.name}
									onSelect={() => onSelect(labelView)}
									selected={view !== null && mailViewsEqual(view, labelView)}
								/>
							);
						})}
					</ul>
				</section>
			) : null}
		</nav>
	);
}
