// apps/desktop/src/components/chat/ThreadHierarchyCrumbs.tsx
//
// The breadcrumb half of the thread bar: Project › Bot › Session.
//   - a chain longer than the limit folds its middle into a "…" menu that
//     lists the hidden ancestors, so a deep nest still fits one row;
//   - every crumb shows the run status of its thread as a dot;
//   - a crumb with threads beside it opens a menu of them, so moving sideways
//     does not need a trip to the parent;
//   - arrow keys move between crumbs, Home and End jump to the ends, Enter
//     opens the focused crumb and Alt+ArrowUp opens the parent.
// Arrow keys follow the reading direction, and the separators mirror with it.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Breadcrumb,
	BreadcrumbEllipsis,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ryu/ui/components/breadcrumb.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Fragment,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useState,
} from "react";
import { conversationRunStatusMeta } from "@/src/lib/conversation-run-status.ts";
import {
	CRUMB_LIMIT,
	collapseCrumbs,
	type HierarchyCrumb,
} from "@/src/lib/thread-hierarchy.ts";

type OpenConversation = (conversationId: string, title?: string) => void;

/** Every control the arrow keys move between carries this attribute. */
const STOP_SELECTOR = "[data-crumb-stop]";
const MENU_TRIGGER_CLASS =
	"inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Whether an element is narrower than `maxWidth`. Returns the ref callback to
 * attach and the answer, which stays false where nothing is laid out.
 */
export function useNarrowElement(
	maxWidth: number
): [(element: HTMLElement | null) => void, boolean] {
	const [element, setElement] = useState<HTMLElement | null>(null);
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			if (width > 0) {
				setNarrow(width < maxWidth);
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [element, maxWidth]);
	return [setElement, narrow];
}

/** The run status of a thread as a small dot. Nothing for a thread with none. */
export function RunStatusDot({
	className,
	status,
}: {
	className?: string;
	status: string | null | undefined;
}) {
	const tl = useLiteralMessages();
	const meta = conversationRunStatusMeta(status ?? undefined);
	if (!meta) {
		return null;
	}
	const label = tl(meta.label);
	return (
		<span
			aria-label={label}
			className={cn("size-1.5 shrink-0 rounded-full", meta.dotClass, className)}
			data-run-status={status}
			role="img"
			title={label}
		/>
	);
}

/**
 * Whether an element reads right to left. The nearest `dir` attribute decides;
 * the computed direction covers `dir="auto"` and direction set from CSS.
 */
export function readsRightToLeft(nav: HTMLElement): boolean {
	const declared = nav.closest("[dir]")?.getAttribute("dir");
	if (declared === "rtl" || declared === "ltr") {
		return declared === "rtl";
	}
	return getComputedStyle(nav).direction === "rtl";
}

/** The control the arrow key should move focus to, or null to leave it. */
function nextStop(
	nav: HTMLElement,
	target: HTMLElement,
	key: string
): HTMLElement | null {
	const stops = [...nav.querySelectorAll<HTMLElement>(STOP_SELECTOR)];
	const index = stops.indexOf(target);
	if (index === -1) {
		return null;
	}
	const forward = readsRightToLeft(nav) ? -1 : 1;
	switch (key) {
		case "ArrowRight":
			return stops[index + forward] ?? null;
		case "ArrowLeft":
			return stops[index - forward] ?? null;
		case "Home":
			return stops[0] ?? null;
		case "End":
			return stops.at(-1) ?? null;
		default:
			return null;
	}
}

function SiblingMenu({
	crumb,
	onOpenConversation,
}: {
	crumb: HierarchyCrumb;
	onOpenConversation: OpenConversation;
}) {
	const tl = useLiteralMessages();
	if (crumb.siblings.length === 0) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={tl("Other threads next to {title}", {
					title: crumb.label,
				})}
				className={MENU_TRIGGER_CLASS}
				data-crumb-stop=""
				data-testid="crumb-siblings"
			>
				<HugeiconsIcon
					className="size-3.5"
					icon={ArrowDown01Icon}
					strokeWidth={2}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="max-w-72" side="bottom">
				{crumb.siblings.map((sibling) => (
					<DropdownMenuItem
						density="compact"
						key={sibling.conversationId}
						onClick={() =>
							onOpenConversation(sibling.conversationId, sibling.label)
						}
					>
						<RunStatusDot status={sibling.runStatus} />
						<span
							className="truncate"
							data-ryu-i18n="off"
							title={sibling.label}
						>
							{sibling.label}
						</span>
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

function HiddenCrumbs({
	hidden,
	onOpenConversation,
}: {
	hidden: readonly HierarchyCrumb[];
	onOpenConversation: OpenConversation;
}) {
	const tl = useLiteralMessages();
	return (
		<BreadcrumbItem>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label={tl("Show hidden parent threads")}
					className={MENU_TRIGGER_CLASS}
					data-crumb-stop=""
					data-testid="crumb-hidden"
				>
					<BreadcrumbEllipsis />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="max-w-72" side="bottom">
					{hidden.map((crumb) => (
						<DropdownMenuItem
							density="compact"
							key={crumb.id}
							onClick={() => onOpenConversation(crumb.id, crumb.label)}
						>
							<RunStatusDot status={crumb.runStatus} />
							<span
								className="truncate"
								data-ryu-i18n="off"
								title={crumb.label}
							>
								{crumb.label}
							</span>
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
		</BreadcrumbItem>
	);
}

function Crumb({
	crumb,
	isParent,
	onOpenConversation,
}: {
	crumb: HierarchyCrumb;
	isParent: boolean;
	onOpenConversation: OpenConversation;
}) {
	const target = crumb.conversationId;
	return (
		<BreadcrumbItem
			className="min-w-0"
			data-crumb-kind={crumb.kind}
			data-testid="crumb"
		>
			<RunStatusDot status={crumb.runStatus} />
			{target ? (
				<BreadcrumbLink
					render={
						<button
							aria-keyshortcuts={isParent ? "Alt+ArrowUp" : undefined}
							className="min-w-0 max-w-48 truncate rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							data-crumb-stop=""
							data-ryu-i18n="off"
							onClick={() => onOpenConversation(target, crumb.label)}
							title={crumb.label}
							type="button"
						/>
					}
				>
					{crumb.label}
				</BreadcrumbLink>
			) : (
				<BreadcrumbPage
					className="min-w-0 truncate"
					data-ryu-i18n="off"
					title={crumb.label}
				>
					{crumb.label}
				</BreadcrumbPage>
			)}
			<SiblingMenu crumb={crumb} onOpenConversation={onOpenConversation} />
		</BreadcrumbItem>
	);
}

export function ThreadHierarchyCrumbs({
	crumbs,
	limit = CRUMB_LIMIT,
	onOpenConversation,
}: {
	crumbs: readonly HierarchyCrumb[];
	/** How many crumbs fit before the middle of the chain collapses. */
	limit?: number;
	onOpenConversation: OpenConversation;
}) {
	const parts = useMemo(() => collapseCrumbs(crumbs, limit), [crumbs, limit]);
	const parent = crumbs.at(-2);

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		const nav = event.currentTarget;
		const from = event.target;
		// A menu is a React child of the bar but lives in a portal. Its own keys
		// are not the bar's.
		if (!(from instanceof HTMLElement && nav.contains(from))) {
			return;
		}
		if (event.altKey && event.key === "ArrowUp") {
			if (parent?.conversationId) {
				event.preventDefault();
				onOpenConversation(parent.conversationId, parent.label);
			}
			return;
		}
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		const stop = nextStop(nav, from, event.key);
		if (stop) {
			event.preventDefault();
			stop.focus();
		}
	};

	const visible = [
		...parts.head.map((crumb) => ({ crumb, key: crumb.id })),
		...(parts.hidden.length > 0 ? [{ crumb: null, key: "hidden" }] : []),
		...parts.tail.map((crumb) => ({ crumb, key: crumb.id })),
	];

	return (
		<Breadcrumb className="min-w-0" onKeyDown={onKeyDown}>
			<BreadcrumbList className="flex-nowrap">
				{visible.map(({ crumb, key }, index) => (
					<Fragment key={key}>
						{index > 0 ? <BreadcrumbSeparator className="shrink-0" /> : null}
						{crumb ? (
							<Crumb
								crumb={crumb}
								isParent={crumb.id === parent?.id}
								onOpenConversation={onOpenConversation}
							/>
						) : (
							<HiddenCrumbs
								hidden={parts.hidden}
								onOpenConversation={onOpenConversation}
							/>
						)}
					</Fragment>
				))}
			</BreadcrumbList>
		</Breadcrumb>
	);
}
