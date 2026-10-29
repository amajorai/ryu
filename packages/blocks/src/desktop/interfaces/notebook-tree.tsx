import { useLiteralMessages } from "@ryu/i18n/react";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceSnapshot,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { ChevronRight, FolderClosed, Plus, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { agentById } from "./interface-renderer.ts";
import {
	type NotebookGroup,
	type NotebookPage,
	type NotebookSection,
	notebookTreeMove,
	visibleNotebookRows,
} from "./notebook-model.ts";
import {
	NotebookAgentArt,
	NotebookPageGlyph,
	NotebookStatusMark,
	sidebarShowsStatus,
} from "./notebook-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/** Left padding per tree depth, in px (Notion nests by ~14px). */
const INDENT = 14;
const BASE_PAD = 6;

function indent(level: number): number {
	return BASE_PAD + Math.max(0, level - 2) * INDENT;
}

/**
 * The row look shared by every tree item. The item (`li`) owns focus; the
 * row draws the focus ring so a focused parent does not ring its children.
 */
const ROW =
	"group/row relative flex h-7 w-full cursor-pointer select-none items-center gap-1.5 rounded-md pe-1.5 font-medium text-sm transition-colors duration-100 [:focus-visible>&]:ring-2 [:focus-visible>&]:ring-ring/50 data-[revealed=on]:bg-sidebar-accent data-[revealed=on]:text-sidebar-accent-foreground data-[revealed=fade]:duration-700 data-[revealed=fade]:ease-out motion-reduce:data-[revealed=fade]:duration-0";

/** How long a revealed row holds its highlight, then how long it fades. */
const REVEAL_HOLD_MS = 260;
const REVEAL_FADE_MS = 700;

export interface NotebookTreeProps {
	activeThreadId: string | null;
	expanded: ReadonlySet<string>;
	/** Ask the tree to move keyboard focus to this row (e.g. from a crumb). */
	focusRequest: { id: string; token: number } | null;
	onOpen: (threadId: string) => void;
	onSetExpanded: (id: string, open: boolean) => void;
	onStart: (group: NotebookGroup) => void;
	sections: readonly NotebookSection[];
	snapshot: InterfaceSnapshot;
}

/**
 * Notion's page tree as a WAI-ARIA tree: sections, parents (projects, teams,
 * agents), and pages. One row holds the tab stop; arrows move and fold, Enter
 * opens a page or folds a parent, and N starts a page in the focused parent.
 */
export function NotebookTree({
	activeThreadId,
	expanded,
	focusRequest,
	onOpen,
	onSetExpanded,
	onStart,
	sections,
	snapshot,
}: NotebookTreeProps) {
	const tl = useLiteralMessages();
	const rows = useMemo(
		() => visibleNotebookRows(sections, expanded),
		[sections, expanded]
	);
	const activeRowId =
		rows.find(
			(row) =>
				row.node.kind === "page" &&
				row.node.threadId === activeThreadId &&
				!row.id.startsWith("section:favorites")
		)?.id ?? null;
	const [focusId, setFocusId] = useState<string | null>(null);
	// The tab stop: the last focused row while it is visible, else the open
	// page, else the first row.
	const tabStopId =
		(focusId && rows.some((row) => row.id === focusId) ? focusId : null) ??
		activeRowId ??
		rows[0]?.id ??
		null;
	const items = useRef(new Map<string, HTMLLIElement>());
	const pendingFocus = useRef<string | null>(null);

	useEffect(() => {
		const id = pendingFocus.current;
		if (id && id === tabStopId) {
			pendingFocus.current = null;
			items.current.get(id)?.focus();
		}
	});

	// A crumb's reveal also flashes the row: after a mouse click the moved
	// focus has no visible ring, so the highlight shows where the row is.
	const [revealed, setRevealed] = useState<{
		id: string;
		phase: "fade" | "on";
	} | null>(null);

	useEffect(() => {
		if (!focusRequest) {
			return;
		}
		pendingFocus.current = focusRequest.id;
		setFocusId(focusRequest.id);
		items.current.get(focusRequest.id)?.focus();
		setRevealed({ id: focusRequest.id, phase: "on" });
		const fade = window.setTimeout(
			() => setRevealed({ id: focusRequest.id, phase: "fade" }),
			REVEAL_HOLD_MS
		);
		const clear = window.setTimeout(
			() => setRevealed(null),
			REVEAL_HOLD_MS + REVEAL_FADE_MS
		);
		return () => {
			window.clearTimeout(fade);
			window.clearTimeout(clear);
		};
	}, [focusRequest]);

	const revealPhase = (id: string) =>
		revealed?.id === id ? revealed.phase : undefined;

	const moveFocus = (id: string) => {
		pendingFocus.current = id;
		setFocusId(id);
		items.current.get(id)?.focus();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
		if (event.target instanceof HTMLButtonElement) {
			return;
		}
		const current = tabStopId;
		if (!current) {
			return;
		}
		const row = rows.find((candidate) => candidate.id === current);
		if (
			(event.key === "n" || event.key === "N") &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey &&
			row?.node.kind === "group"
		) {
			event.preventDefault();
			onStart(row.node);
			return;
		}
		const move = notebookTreeMove(rows, current, event.key);
		if (!move) {
			return;
		}
		event.preventDefault();
		switch (move.type) {
			case "focus":
				moveFocus(move.id);
				break;
			case "expand":
				onSetExpanded(move.id, true);
				break;
			case "collapse":
				onSetExpanded(move.id, false);
				break;
			case "toggle":
				onSetExpanded(move.id, !expanded.has(move.id));
				break;
			default:
				onOpen(move.threadId);
		}
	};

	const register = (id: string) => (element: HTMLLIElement | null) => {
		if (element) {
			items.current.set(id, element);
		} else {
			items.current.delete(id);
		}
	};

	const itemProps = (
		id: string,
		level: number,
		index: number,
		size: number
	) => ({
		"aria-level": level,
		"aria-posinset": index + 1,
		"aria-setsize": size,
		"data-node-id": id,
		onFocus: (event: { target: EventTarget; currentTarget: EventTarget }) => {
			if (event.target === event.currentTarget) {
				setFocusId(id);
			}
		},
		ref: register(id),
		role: "treeitem" as const,
		tabIndex: id === tabStopId ? 0 : -1,
	});

	const renderPage = (
		page: NotebookPage,
		level: number,
		index: number,
		size: number
	) => {
		const active = page.threadId === activeThreadId;
		return (
			<li
				{...itemProps(page.id, level, index, size)}
				aria-current={active ? "page" : undefined}
				aria-label={`${page.title}, ${THREAD_STATUS_LABELS[page.status]}`}
				aria-selected={active}
				className="outline-none"
				key={page.id}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the treeitem owns keyboard access; this row is its pointer target. */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on the treeitem opens the page. */}
				<div
					className={cn(
						ROW,
						active
							? "bg-sidebar-accent text-sidebar-accent-foreground"
							: "text-sidebar-foreground/80 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
					)}
					onClick={() => {
						setFocusId(page.id);
						onOpen(page.threadId);
					}}
					style={{ paddingInlineStart: indent(level) }}
				>
					<span className="flex size-5 shrink-0 items-center justify-center">
						<NotebookPageGlyph
							className={cn(active && "text-sidebar-accent-foreground")}
						/>
					</span>
					<span className="min-w-0 flex-1 truncate">{page.title}</span>
					{sidebarShowsStatus(page.status) ? (
						<NotebookStatusMark className="me-1" status={page.status} />
					) : null}
				</div>
			</li>
		);
	};

	const renderGroup = (
		group: NotebookGroup,
		level: number,
		index: number,
		size: number
	) => {
		const open = expanded.has(group.id);
		const agent =
			group.groupKind === "agent"
				? agentById(snapshot, group.entityId)
				: undefined;
		const agentWorking = agent?.status === "working";
		const holdsActive = group.pages.some(
			(page) => page.threadId === activeThreadId
		);
		const toggle = (event: MouseEvent) => {
			event.stopPropagation();
			setFocusId(group.id);
			onSetExpanded(group.id, !open);
		};
		const startHere = (event: MouseEvent) => {
			event.stopPropagation();
			onStart(group);
		};
		let icon: ReactNode;
		if (group.groupKind === "agent") {
			icon = (
				<NotebookAgentArt agent={agent} className="size-4.5" shape="tile" />
			);
		} else if (group.groupKind === "team") {
			icon = (
				<Users
					aria-hidden="true"
					className="size-4 text-muted-foreground"
					strokeWidth={1.75}
				/>
			);
		} else {
			icon = (
				<FolderClosed
					aria-hidden="true"
					className="size-4 text-muted-foreground"
					strokeWidth={1.75}
				/>
			);
		}
		const kindLabel = group.groupKind === "agent" ? "agent" : group.groupKind;
		return (
			<li
				{...itemProps(group.id, level, index, size)}
				aria-expanded={open}
				aria-keyshortcuts="N"
				aria-label={`${group.label}, ${kindLabel}${agentWorking ? ", working" : ""}, ${group.pages.length} ${
					group.pages.length === 1 ? "page" : "pages"
				}`}
				className="outline-none"
				key={group.id}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: the treeitem owns keyboard access; this row is its pointer target. */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on the treeitem folds the parent. */}
				<div
					className={cn(
						ROW,
						"text-sidebar-foreground/85 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground",
						group.pages.length === 0 && "text-sidebar-foreground/75",
						holdsActive && !open && "text-sidebar-foreground"
					)}
					data-revealed={revealPhase(group.id)}
					onClick={toggle}
					style={{ paddingInlineStart: indent(level) }}
				>
					<span className="relative flex size-5 shrink-0 items-center justify-center">
						<span className="flex items-center justify-center transition-opacity duration-100 group-hover/row:opacity-0">
							{icon}
						</span>
						<ChevronRight
							aria-hidden="true"
							className={cn(
								"absolute size-3.5 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100",
								open && "rotate-90"
							)}
							strokeWidth={2.25}
						/>
					</span>
					<span className="min-w-0 flex-1 truncate">{group.label}</span>
					{agentWorking ? (
						<span className="flex size-5 items-center justify-center group-hover/row:hidden [:focus-visible>*>&]:hidden">
							<NotebookStatusMark status="working" />
						</span>
					) : null}
					<Kbd
						aria-hidden="true"
						className="hidden h-5 min-w-5 rounded-sm px-1 text-xs [:focus-visible>*>&]:inline-flex"
					>
						N
					</Kbd>
					<Tooltip>
						<TooltipTrigger
							render={
								<button
									aria-label={tl("New page in {label}", {
										label: group.label,
									})}
									className="hidden size-5 items-center justify-center rounded text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:flex focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/row:flex [:focus-visible>*>&]:flex"
									onClick={startHere}
									tabIndex={-1}
									type="button"
								/>
							}
						>
							<Plus
								aria-hidden="true"
								className="size-3.5"
								strokeWidth={2.25}
							/>
						</TooltipTrigger>
						<TooltipContent side="right">
							{tl("New page in {label}", { label: group.label })}
							<Kbd>N</Kbd>
						</TooltipContent>
					</Tooltip>
				</div>
				<Collapse open={open}>
					<ul className="flex flex-col gap-px pt-px" role="group">
						{group.pages.length === 0 ? (
							<li
								className="flex h-7 items-center text-muted-foreground/80 text-sm"
								role="presentation"
								style={{ paddingInlineStart: indent(level + 1) + 26 }}
							>
								No pages inside
							</li>
						) : (
							group.pages.map((page, pageIndex) =>
								renderPage(page, level + 1, pageIndex, group.pages.length)
							)
						)}
					</ul>
				</Collapse>
			</li>
		);
	};

	return (
		<ul
			aria-label="Pages"
			className="flex flex-col gap-px"
			onKeyDown={onKeyDown}
			// biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the WAI-ARIA tree pattern is built on ul/li; the list owns the roving keyboard.
			role="tree"
		>
			{sections.map((section, sectionIndex) => {
				const open = expanded.has(section.id);
				return (
					<li
						{...itemProps(section.id, 1, sectionIndex, sections.length)}
						aria-expanded={open}
						aria-label={section.label}
						className={cn("outline-none", sectionIndex > 0 && "pt-3")}
						key={section.id}
					>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: the treeitem owns keyboard access; this row is its pointer target. */}
						{/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter on the treeitem folds the section. */}
						<div
							className={cn(
								ROW,
								"h-7 gap-1 px-2 font-medium text-muted-foreground text-xs hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
							)}
							data-revealed={revealPhase(section.id)}
							onClick={() => {
								setFocusId(section.id);
								onSetExpanded(section.id, !open);
							}}
						>
							<span className="truncate">{section.label}</span>
							<ChevronRight
								aria-hidden="true"
								className={cn(
									"size-3 opacity-0 transition-[opacity,transform] duration-150 group-hover/row:opacity-100",
									open && "rotate-90"
								)}
								strokeWidth={2.5}
							/>
						</div>
						<Collapse open={open}>
							<ul className="flex flex-col gap-px pt-px" role="group">
								{section.children.map((child, childIndex) =>
									child.kind === "group"
										? renderGroup(child, 2, childIndex, section.children.length)
										: renderPage(child, 2, childIndex, section.children.length)
								)}
							</ul>
						</Collapse>
					</li>
				);
			})}
		</ul>
	);
}

/** Height-animated fold; instant when the reader prefers reduced motion. */
function Collapse({ children, open }: { children: ReactNode; open: boolean }) {
	const reduceMotion = useReducedMotion();
	return (
		<AnimatePresence initial={false}>
			{open ? (
				<motion.div
					animate={{ height: "auto", opacity: 1 }}
					className="overflow-hidden"
					exit={{ height: 0, opacity: 0 }}
					initial={{ height: 0, opacity: 0 }}
					transition={
						reduceMotion
							? { duration: 0 }
							: { duration: 0.18, ease: [0.2, 0, 0, 1] }
					}
				>
					{children}
				</motion.div>
			) : null}
		</AnimatePresence>
	);
}
