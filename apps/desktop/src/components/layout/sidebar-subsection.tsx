import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString } from "@ryu/i18n/react";
import { useDisplayDayRevision } from "@ryu/ui/lib/display-day.ts";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	type DragEvent as ReactDragEvent,
	type ReactNode,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTimezoneRevision } from "@/src/hooks/useTimezone.ts";
import {
	parseVisibilityDragPayload,
	RESOURCE_VISIBILITY_DND_MIME,
	resourceVisibilityDndMime,
} from "@/src/lib/resource-visibility.ts";
import {
	bucketByDate,
	DATE_BUCKET_LABELS,
	type DateBucket,
} from "@/src/lib/sidebar/date-buckets.ts";
import { startOfDisplayDayMs } from "@/src/lib/timezone.ts";
import { sidebarCivilStarts } from "./sidebar-agent-rows.tsx";
import {
	type ChatMoveDrop,
	useChatMoveDropTarget,
} from "./sidebar-chat-selection.tsx";
import {
	SUBSECTION_REORDER_EDGE,
	type SubSectionDnd,
	useNestedSections,
	type VisibilitySubSectionDrop,
} from "./sidebar-nested-sections.ts";

/** A nested, collapsible, drag-reorderable sub-section that reuses the parent
 *  section header's look (chevron + grab cursor + hover). Indented under its
 *  parent for hierarchy. */
export function SubSection({
	action,
	chatDrop,
	children,
	collapsed,
	count,
	dnd,
	icon,
	iconNode,
	label,
	onToggleCollapsed,
	sectionKey,
	size = "sm",
	testId,
	trailing,
	visibilityDrop,
	wrapHeader,
}: {
	action?: ReactNode;
	/** Accept chat rows dragged in from elsewhere (e.g. move into a project). */
	chatDrop?: ChatMoveDrop;
	children: ReactNode;
	collapsed: boolean;
	count?: number;
	dnd: SubSectionDnd;
	icon?: IconSvgElement;
	/** Custom glyph that replaces `icon` when provided (e.g. a project's emoji/logo). */
	iconNode?: ReactNode;
	label: string;
	onToggleCollapsed: (key: string) => void;
	sectionKey: string;
	testId?: string;
	/**
	 * `sm` (default) is the quiet date-bucket header inside Chats — a divider for
	 * rows that are themselves the content. `md` matches a ChatRow exactly (h-8,
	 * `text-sm`, 16px icon) and is for a sub-section that IS an entity in its own
	 * right, like a project folder: those sit beside Chats and Spaces in the same
	 * scan, so rendering them two steps smaller made them read as sub-labels of
	 * the section above rather than peers of it.
	 */
	size?: "sm" | "md";
	/** Optional resource visibility drop target for this group header/body. */
	visibilityDrop?: VisibilitySubSectionDrop;
	/** Optional metadata kept beside the label, such as remote node status. */
	trailing?: ReactNode;
	/** Optional wrapper for the header row — e.g. a right-click "Delete all
	 *  chats" context menu. Defaults to identity (no wrapper). */
	wrapHeader?: (header: ReactNode) => ReactNode;
}) {
	const localizedLabel = useLocalizedString(label) ?? label;
	const headerRef = useRef<HTMLDivElement>(null);
	const isNestOver =
		dnd.nestOverKey === sectionKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== sectionKey;
	const isDragOver =
		!(isNestOver || dnd.shift.previewing) &&
		dnd.dragOverKey === sectionKey &&
		dnd.draggingKey !== null &&
		dnd.draggingKey !== sectionKey;
	const isDragging = dnd.draggingKey === sectionKey;
	const dropBelow =
		isDragOver &&
		dnd.draggingKey !== null &&
		dnd.order.indexOf(dnd.draggingKey) < dnd.order.indexOf(sectionKey);
	const [visibilityDragOver, setVisibilityDragOver] = useState(false);
	const chatMove = useChatMoveDropTarget(chatDrop);
	const dropHighlighted = visibilityDragOver || chatMove.isOver;
	const readVisibilityPayload = (event: ReactDragEvent<HTMLDivElement>) => {
		const customPayload = parseVisibilityDragPayload(
			event.dataTransfer.getData(RESOURCE_VISIBILITY_DND_MIME)
		);
		return (
			customPayload ??
			parseVisibilityDragPayload(event.dataTransfer.getData("text/plain"))
		);
	};
	return (
		// sub-section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		// sub-section is the drag-and-drop reorder target; the header button carries the keyboard-reachable affordance
		<div
			className={`group/subsection relative ${isDragging ? "opacity-50" : ""} ${dropHighlighted ? "rounded-md bg-primary/5 ring-1 ring-primary/60" : ""}`}
			data-subsection-key={sectionKey}
			data-testid={testId}
			onDragLeave={(e) => {
				chatMove.onDragLeave(e);
				const relatedTarget = e.relatedTarget;
				if (
					!(
						relatedTarget instanceof Node &&
						e.currentTarget.contains(relatedTarget)
					)
				) {
					setVisibilityDragOver(false);
				}
			}}
			onDragOver={(e) => {
				const visibilityDrag =
					visibilityDrop &&
					e.dataTransfer.types.includes(
						resourceVisibilityDndMime(visibilityDrop.accept)
					);
				if (visibilityDrag) {
					const allowed = visibilityDrop.canDropOnDragOver?.() ?? true;
					setVisibilityDragOver(allowed);
					e.dataTransfer.dropEffect = allowed ? "move" : "none";
					if (allowed) {
						e.preventDefault();
						e.stopPropagation();
					}
					return;
				}
				setVisibilityDragOver(false);
				if (chatMove.onDragOver(e)) {
					return;
				}
				// Only intercept our own sub-section drags; let a top-level section
				// drag pass through to the parent group's handler.
				const dragKey = dnd.draggingKey;
				if (!dragKey) {
					return;
				}
				e.stopPropagation();
				const intoTarget =
					dnd.nesting?.canNestInto(dragKey, sectionKey) === true &&
					isInHeaderMiddle(headerRef.current, e.clientY);
				// Siblings have slid aside, so a reorder targets the resting slot
				// under the pointer rather than whichever header is drawn there.
				const overKey = intoTarget
					? sectionKey
					: dnd.shift.resolveOver(sectionKey, e.clientX, e.clientY);
				if (overKey === dragKey) {
					// Back over its own slot: a valid drop that changes nothing.
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					dnd.onDragOver(dragKey);
					return;
				}
				if (
					dnd.nesting &&
					!intoTarget &&
					!dnd.nesting.canPlaceBeside(dragKey, overKey)
				) {
					// E.g. a section over its own descendant: nothing valid here.
					e.dataTransfer.dropEffect = "none";
					dnd.onDragOver(dragKey);
					return;
				}
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				dnd.onDragOver(overKey, intoTarget);
			}}
			onDrop={(e) => {
				const visibilityPayload = visibilityDrop
					? readVisibilityPayload(e)
					: null;
				if (
					visibilityDrop &&
					visibilityPayload?.resourceType === visibilityDrop.accept &&
					visibilityPayload.from !== sectionKey
				) {
					e.preventDefault();
					e.stopPropagation();
					setVisibilityDragOver(false);
					// Let the native dragend/pointer-release sequence finish before
					// opening a modal. Otherwise the release can be interpreted as an
					// outside interaction and immediately dismiss the confirmation.
					setTimeout(() => {
						if (visibilityDrop.canDrop(visibilityPayload)) {
							visibilityDrop.onDrop(visibilityPayload);
						}
					}, 0);
					return;
				}
				setVisibilityDragOver(false);
				if (chatMove.onDrop(e)) {
					return;
				}
				if (!dnd.draggingKey) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				dnd.onDrop(sectionKey);
			}}
			ref={dnd.shift.register(sectionKey)}
			style={dnd.shift.styleFor(sectionKey)}
		>
			{isDragOver && (
				<div
					className={`reorder-drop-indicator pointer-events-none absolute inset-x-1 z-10 h-0.5 bg-primary ${dropBelow ? "bottom-0" : "top-0"}`}
				/>
			)}
			{dropHighlighted && (
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 rounded-md border border-primary/50"
				/>
			)}
			{(() => {
				const headerRow = (
					<div
						className={`relative flex items-center rounded-md ${isNestOver ? "bg-primary/10 ring-1 ring-primary/60" : ""}`}
						data-nest-target={isNestOver ? "true" : undefined}
						ref={headerRef}
					>
						<button
							className={`group/hdr flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 text-foreground transition-colors active:cursor-grabbing ${
								size === "md" ? "h-8 text-sm hover:bg-muted" : "py-1 text-xs"
							}`}
							draggable
							onClick={() => onToggleCollapsed(sectionKey)}
							onDragEnd={() => dnd.onDragEnd()}
							onDragStart={(e) => {
								e.dataTransfer.effectAllowed = "move";
								e.dataTransfer.setData("text/plain", sectionKey);
								dnd.onDragStart(sectionKey);
							}}
							type="button"
						>
							{iconNode ??
								(icon && (
									<HugeiconsIcon
										className={`shrink-0 ${size === "md" ? "size-4" : "size-3.5"}`}
										icon={icon}
									/>
								))}
							<span className="min-w-0 truncate">{localizedLabel}</span>
							{trailing}
							{count !== undefined && (
								<span
									className={`shrink-0 text-muted-foreground/60 ${action ? "transition-opacity group-hover/subsection:opacity-0" : ""}`}
								>
									{formatCount(count) ?? "—"}
								</span>
							)}
							<HugeiconsIcon
								className={`-ml-0.5 size-3 shrink-0 opacity-0 transition group-hover/hdr:opacity-100 ${collapsed ? "-rotate-90" : ""}`}
								icon={ArrowDown01Icon}
							/>
						</button>
						{action && (
							<div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center">
								{action}
							</div>
						)}
					</div>
				);
				return wrapHeader ? wrapHeader(headerRow) : headerRow;
			})()}
			{!collapsed && <div className="mt-0.5">{children}</div>}
		</div>
	);
}

/** Whether `clientY` falls in the "drop inside" band of a sub-section header. */
function isInHeaderMiddle(header: HTMLElement | null, clientY: number) {
	if (!header) {
		return false;
	}
	const rect = header.getBoundingClientRect();
	const edge = rect.height * SUBSECTION_REORDER_EDGE;
	return clientY > rect.top + edge && clientY < rect.bottom - edge;
}

/**
 * The two localStorage keys one date-bucketed list needs, namespaced by `scope`.
 *
 * Per-scope rather than global because collapse state is per-LIST: collapsing
 * "Older" inside one project must not collapse it inside the next one, and the
 * Chats section's buckets are a third independent surface. Chats itself keeps its
 * ORIGINAL keys (passed explicitly) so nobody's existing collapse state resets when
 * this generalization ships.
 */
export function dateBucketStorageKeys(scope: string) {
	return {
		collapsedKey: `ryu:sidebar-collapsed-date-buckets:${scope}`,
		orderKey: `ryu:sidebar-date-bucket-order:${scope}`,
	};
}

/**
 * Any list of rows, bucketed by date into collapsible/reorderable sub-sections.
 *
 * The render half of `lib/sidebar/date-buckets.ts` and the reason "group by date" is
 * now a sidebar-wide primitive rather than a property of the Chats section: a caller
 * supplies its rows, the accessor that dates one (`stampOf`), a storage scope, and
 * how to draw a run of them (`renderRows`). Everything else — bucketing, the display
 * zone, per-bucket collapse and drag order — is shared.
 *
 * Returns `null` when there is nothing to bucket, which is the signal for the caller
 * to fall back to its flat body. Hooks run before that return, so the fallback is a
 * render decision, not a conditional-hook hazard.
 *
 * `renderRows` receives one bucket's rows, so a caller keeps its own row component
 * (a chat row, a space document row, a contributed row) unchanged.
 */
export function DateGroupedRows<T>({
	className = "space-y-0.5",
	collapsedKey,
	items,
	orderKey,
	renderRows,
	stampOf,
	wrapHeader,
}: {
	/**
	 * Wrapper classes, which in practice means the bucket headers' INDENT. A bucket
	 * is a divider that has to line up with the rows it introduces, and those rows
	 * sit at different depths per surface: a chat row at the section's own indent, a
	 * space document two steps in under its space. Defaults to no indent.
	 */
	className?: string;
	collapsedKey: string;
	items: T[];
	orderKey: string;
	renderRows: (rows: T[]) => ReactNode;
	stampOf: (item: T) => number | string | null | undefined;
	/** Optional wrapper for a bucket's header — e.g. a "Delete all chats" menu
	 *  scoped to that bucket. */
	wrapHeader?: (bucket: DateBucket<T>, header: ReactNode) => ReactNode;
}) {
	// Which bucket a row lands in depends on midnight in the DISPLAY zone, so the
	// revision has to be a dependency — not just a subscription.
	const timezoneRevision = useTimezoneRevision();
	const dayRevision = useDisplayDayRevision();
	const buckets = useMemo(
		() => {
			const now = Date.now();
			return bucketByDate(
				items,
				stampOf,
				startOfDisplayDayMs(now),
				sidebarCivilStarts(now)
			);
		},
		// biome-ignore lint/correctness/useExhaustiveDependencies: bucketing reads
		// the display zone at call time; the revision is what invalidates it.
		[items, stampOf, timezoneRevision, dayRevision]
	);
	// Keyed by plain string: `useNestedSections` speaks the same string-keyed
	// vocabulary as every other reorderable surface, so the bucket key crosses that
	// boundary widened rather than making the shared machinery generic.
	const bucketByKey = useMemo(
		() => new Map<string, DateBucket<T>>(buckets.map((b) => [b.key, b])),
		[buckets]
	);
	const bucketKeys = useMemo<string[]>(
		() => buckets.map((b) => b.key),
		[buckets]
	);
	const nested = useNestedSections(orderKey, collapsedKey, bucketKeys, false);

	if (buckets.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			{nested.orderedKeys.map((key) => {
				const bucket = bucketByKey.get(key);
				if (!bucket) {
					return null;
				}
				const label = DATE_BUCKET_LABELS[bucket.key] ?? bucket.label;
				return (
					<SubSection
						collapsed={nested.isCollapsed(key)}
						count={bucket.items.length}
						dnd={nested.dnd}
						key={key}
						label={label}
						onToggleCollapsed={nested.toggle}
						sectionKey={key}
						wrapHeader={
							wrapHeader ? (header) => wrapHeader(bucket, header) : undefined
						}
					>
						{renderRows(bucket.items)}
					</SubSection>
				);
			})}
		</div>
	);
}
