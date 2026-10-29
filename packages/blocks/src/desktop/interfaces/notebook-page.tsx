import { useLiteralMessages } from "@ryu/i18n/react";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	type InterfaceThread,
	type ThreadRunState,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	ChevronDown,
	ChevronRight,
	CircleDashed,
	CircleUserRound,
	Clock3,
	Ellipsis,
	FolderClosed,
	Hash,
	History,
	PanelLeft,
	Users,
	X,
} from "lucide-react";
import { motion } from "motion/react";
import { Fragment, type ReactNode, useId } from "react";
import { compactAge } from "./interface-renderer.ts";
import { notebookEditedLabel, notebookTimestamp } from "./notebook-model.ts";
import {
	NOTEBOOK_FAINT,
	NOTEBOOK_INK,
	NotebookAgentArt,
	NotebookPageIcon,
	NotebookStatusPill,
} from "./notebook-parts.tsx";
import { NotebookIconButton } from "./notebook-sidebar.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface NotebookCrumb {
	icon?: ReactNode;
	id: string;
	label: string;
	/** Reveal this crumb's row in the sidebar; absent on the current page. */
	onSelect?: () => void;
}

/**
 * Notion's "•••" page menu: layout switches live here, not as loose icons in
 * the top bar.
 */
function PageMenu({
	fullWidth,
	onToggleFullWidth,
	properties,
}: {
	fullWidth: boolean;
	onToggleFullWidth: () => void;
	properties?: { onToggle: () => void; open: boolean };
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<button
						aria-label="Page options"
						className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-foreground/10 data-[popup-open]:bg-foreground/[0.06] data-[popup-open]:text-foreground [&_svg]:size-4"
						title="Page options"
						type="button"
					/>
				}
			>
				<Ellipsis aria-hidden="true" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52" drawerLabel="Page">
				<DropdownMenuCheckboxItem
					checked={fullWidth}
					onCheckedChange={onToggleFullWidth}
				>
					Full width
				</DropdownMenuCheckboxItem>
				{properties ? (
					<DropdownMenuCheckboxItem
						checked={properties.open}
						onCheckedChange={properties.onToggle}
					>
						Show properties
					</DropdownMenuCheckboxItem>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/** The page's top bar: breadcrumbs on the left, page actions on the right. */
export function NotebookTopbar({
	crumbs,
	edited,
	fullWidth,
	onClosePage,
	onShowSidebar,
	onToggleFullWidth,
	properties,
}: {
	crumbs: NotebookCrumb[];
	edited?: { iso: string; label: string } | null;
	fullWidth: boolean;
	onClosePage?: () => void;
	/** On a page: the properties block's state, for the page menu. */
	properties?: { onToggle: () => void; open: boolean };
	/** Set while the sidebar is hidden, to bring it back. */
	onShowSidebar?: () => void;
	onToggleFullWidth: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<header className="flex h-11 shrink-0 items-center gap-1 @xl/notebook:px-3 px-2">
			{onShowSidebar ? (
				<NotebookIconButton
					label="Open sidebar"
					onClick={onShowSidebar}
					shortcut="Control+\"
				>
					<PanelLeft />
				</NotebookIconButton>
			) : null}
			<nav aria-label="Breadcrumb" className="min-w-0 flex-1">
				<ol className="flex min-w-0 items-center gap-0.5 text-sm">
					{crumbs.map((crumb, index) => {
						const last = index === crumbs.length - 1;
						// At narrow widths only the parent and page stay visible.
						const collapsible = !last && index < crumbs.length - 2;
						return (
							<Fragment key={crumb.id}>
								{index > 0 ? (
									<li
										aria-hidden="true"
										className={cn(
											"select-none px-0.5 text-muted-foreground/50",
											index - 1 < crumbs.length - 2 &&
												"@xl/notebook:block hidden"
										)}
									>
										/
									</li>
								) : null}
								<li
									className={cn(
										"flex min-w-0",
										collapsible && "@xl/notebook:flex hidden",
										// A parent keeps its name readable; the page title truncates first.
										last ? "shrink" : "max-w-[min(12rem,40%)] shrink-0"
									)}
								>
									{crumb.onSelect ? (
										<button
											className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground outline-none transition-colors duration-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
											onClick={crumb.onSelect}
											title={tl("Show {label} in the sidebar", {
												label: crumb.label,
											})}
											type="button"
										>
											{crumb.icon}
											<span className="truncate">{crumb.label}</span>
										</button>
									) : (
										<span
											aria-current={last ? "page" : undefined}
											className="flex h-7 min-w-0 items-center gap-1.5 px-1.5 text-foreground"
										>
											{crumb.icon}
											<span className="truncate">{crumb.label}</span>
										</span>
									)}
								</li>
							</Fragment>
						);
					})}
				</ol>
			</nav>
			{edited ? (
				<time
					className="@lg/notebook:block hidden shrink-0 px-2 text-muted-foreground text-xs"
					dateTime={edited.iso}
					title={notebookTimestamp(edited.iso)}
				>
					{tl("Edited {editedLabel}", {
						editedLabel: edited.label.toLowerCase(),
					})}
				</time>
			) : null}
			<PageMenu
				fullWidth={fullWidth}
				onToggleFullWidth={onToggleFullWidth}
				properties={properties}
			/>
			{onClosePage ? (
				<NotebookIconButton label="Close page" onClick={onClosePage}>
					<X />
				</NotebookIconButton>
			) : null}
		</header>
	);
}

/** The reading column: Notion's centered page width, or edge to edge. */
export function notebookColumn(fullWidth: boolean): string {
	return cn(
		"mx-auto w-full @5xl/notebook:px-24 @xl/notebook:px-12 px-6",
		fullWidth ? "max-w-none" : "max-w-[50rem]"
	);
}

function PropertyRow({
	children,
	icon,
	label,
}: {
	children: ReactNode;
	icon: ReactNode;
	label: string;
}) {
	return (
		<div className="flex min-h-9 items-start gap-2">
			<dt className="flex h-9 @lg/notebook:w-40 w-32 shrink-0 items-center gap-1.5 text-muted-foreground text-sm [&_svg]:size-4 [&_svg]:shrink-0">
				{icon}
				<span className="truncate">{label}</span>
			</dt>
			<dd className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1 text-sm">
				{children}
			</dd>
		</div>
	);
}

const RUN_LABELS: Record<ThreadRunState, string> = {
	completed: "Completed",
	failed: "Failed",
	interrupted: "Interrupted",
	running: "Running",
};

const RUN_INK: Record<ThreadRunState, string> = {
	completed: "text-foreground",
	failed: NOTEBOOK_INK.attention,
	interrupted: NOTEBOOK_INK.attention,
	running: NOTEBOOK_INK.working,
};

/** The latest run's outcome and when it settled, e.g. "Failed · 1h ago". */
function LastRunValue({
	now,
	runState,
	updatedAt,
}: {
	now: number;
	runState: ThreadRunState;
	updatedAt: string;
}) {
	const age = compactAge(updatedAt, now);
	let when = "";
	// A run still in flight has no settled time to report.
	if (runState !== "running" && age) {
		when = age === "now" ? "just now" : `${age} ago`;
	}
	return (
		<span className="inline-flex items-center gap-1.5">
			<span className={cn("font-medium", RUN_INK[runState])}>
				{RUN_LABELS[runState]}
			</span>
			{when ? (
				<>
					<span aria-hidden="true" className="text-muted-foreground">
						·
					</span>
					<time
						className="text-muted-foreground"
						dateTime={updatedAt}
						title={notebookTimestamp(updatedAt)}
					>
						{when}
					</time>
				</>
			) : null}
		</span>
	);
}

function EmptyValue() {
	return <span className={NOTEBOOK_FAINT}>Empty</span>;
}

export interface NotebookPageContext {
	agents: InterfaceAgent[];
	project: string | null;
	team: string | null;
}

/**
 * One thread as a Notion page: icon, title, a properties block, then the
 * host's real conversation as the page body. `thread` is null for a page the
 * host is still creating ("Untitled").
 */
export function NotebookThreadPage({
	context,
	fullWidth,
	now,
	onToggleProperties,
	propertiesOpen,
	thread,
	threadView,
}: {
	context: NotebookPageContext;
	fullWidth: boolean;
	now: number;
	onToggleProperties: () => void;
	propertiesOpen: boolean;
	thread: InterfaceThread | null;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const propertiesId = useId();
	const status: ThreadStatus = thread ? threadStatus(thread) : "quiet";
	const title = thread?.title.trim() ?? "";
	const column = notebookColumn(fullWidth);
	const runState = thread?.runState ?? null;
	const propertyCount = runState ? 7 : 6;

	const properties = (
		<dl className="flex flex-col" id={propertiesId}>
			<PropertyRow icon={<CircleDashed />} label="Status">
				<NotebookStatusPill status={status} />
			</PropertyRow>
			<PropertyRow icon={<CircleUserRound />} label="Agents">
				{context.agents.length > 0 ? (
					context.agents.map((agent) => (
						<span
							className="inline-flex h-6 items-center gap-1.5 pe-1"
							key={agent.id}
						>
							<NotebookAgentArt agent={agent} />
							{agent.name}
						</span>
					))
				) : (
					<EmptyValue />
				)}
			</PropertyRow>
			<PropertyRow icon={<Users />} label="Team">
				{context.team ? (
					<span className="truncate">{context.team}</span>
				) : (
					<EmptyValue />
				)}
			</PropertyRow>
			<PropertyRow icon={<FolderClosed />} label="Project">
				{context.project ? (
					<span className="truncate">{context.project}</span>
				) : (
					<EmptyValue />
				)}
			</PropertyRow>
			<PropertyRow icon={<Hash />} label="Messages">
				<span className="tabular-nums">{thread?.messageCount ?? 0}</span>
			</PropertyRow>
			{runState ? (
				<PropertyRow icon={<History />} label="Last run">
					<LastRunValue
						now={now}
						runState={runState}
						updatedAt={thread?.updatedAt ?? ""}
					/>
				</PropertyRow>
			) : null}
			<PropertyRow icon={<Clock3 />} label="Last edited">
				{thread ? (
					<time
						dateTime={thread.updatedAt}
						title={notebookTimestamp(thread.updatedAt)}
					>
						{notebookEditedLabel(thread.updatedAt, now)}
					</time>
				) : (
					<span>Just now</span>
				)}
			</PropertyRow>
		</dl>
	);

	return (
		<div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
			<motion.article
				animate={{ opacity: 1, y: 0 }}
				aria-label={title || "Untitled"}
				className="flex min-h-full flex-col"
				initial={reduceMotion ? false : { opacity: 0, y: 6 }}
				key={thread?.id ?? "new-page"}
				transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
			>
				<div className={cn(column, "shrink-0 @xl/notebook:pt-12 pt-8")}>
					<NotebookPageIcon className="mb-3" />
					<h1
						className={cn(
							"text-balance break-words font-bold @xl/notebook:text-[2.5rem] text-[2rem] leading-[1.15] tracking-tight",
							!title && "text-muted-foreground/45"
						)}
					>
						{title || "Untitled"}
					</h1>
					<div className="mt-5">
						{propertiesOpen ? properties : null}
						<button
							aria-controls={propertiesOpen ? propertiesId : undefined}
							aria-expanded={propertiesOpen}
							className="-ms-1.5 mt-1 flex h-7 items-center gap-1.5 rounded-md px-1.5 text-muted-foreground text-sm outline-none transition-colors duration-100 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
							onClick={onToggleProperties}
							type="button"
						>
							{propertiesOpen ? (
								<ChevronDown aria-hidden="true" className="size-4" />
							) : (
								<ChevronRight aria-hidden="true" className="size-4" />
							)}
							{propertiesOpen
								? "Hide properties"
								: tl(
										"{propertyCount, plural, one {# property} other {# properties}}",
										{ propertyCount }
									)}
							{propertiesOpen ? null : (
								<span className="ms-1 flex items-center gap-2">
									<NotebookStatusPill status={status} />
								</span>
							)}
						</button>
					</div>
				</div>
				<div className={cn(column, "shrink-0 pt-4 pb-1")}>
					<hr className="border-border border-t" />
				</div>
				<div className={cn(column, "flex min-h-[18rem] flex-1 flex-col pb-2")}>
					<div
						className="relative min-h-0 flex-1"
						data-testid="notebook-page-body"
					>
						<div className="absolute inset-0 overflow-hidden">{threadView}</div>
					</div>
				</div>
			</motion.article>
		</div>
	);
}
