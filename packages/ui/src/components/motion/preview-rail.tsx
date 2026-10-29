"use client";

// beui.dev/components/motion/preview-rail

import { useHoverCapable } from "@ryu/ui/hooks/use-hover-capable.ts";
import { EASE_OUT, SPRING_LAYOUT } from "@ryu/ui/lib/ease.ts";
import { safeNavigationUrl } from "@ryu/ui/lib/safe-url.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type CSSProperties, type ReactNode, useId, useState } from "react";

import css from "./preview-rail.module.css";

interface RailStyle extends CSSProperties {
	"--rail-columns"?: CSSProperties["gridTemplateColumns"];
	"--rail-height"?: string;
	"--rail-rows"?: CSSProperties["gridTemplateRows"];
	"--rail-width"?: string;
}

export interface PreviewRailItem {
	ariaLabel?: string;
	/** Arbitrary consumer payload carried through to `renderPreview`. */
	data?: unknown;
	description?: ReactNode;
	href?: string;
	id: string;
	label: string;
	rel?: string;
	target?: "_blank" | "_self" | "_parent" | "_top";
}

export interface PreviewRailProps {
	activeId?: string;
	children?: ReactNode;
	className?: string;
	defaultActiveId?: string;
	highlightActive?: boolean;
	itemSize?: number;
	items: PreviewRailItem[];
	label?: string;
	onActiveChange?: (id: string) => void;
	onItemSelect?: (item: PreviewRailItem) => void;
	orientation?: "vertical" | "horizontal";
	previewClassName?: string;
	previewContainerClassName?: string;
	previewSide?: "before" | "after";
	railClassName?: string;
	renderPreview?: (item: PreviewRailItem) => ReactNode;
	showPreview?: boolean;
}

function DefaultPreview({ item }: { item: PreviewRailItem }) {
	return (
		<div
			className="rounded-2xl border border-border bg-card p-4 shadow-sm"
			data-slot="preview-rail-card"
		>
			<p
				className="font-medium text-card-foreground"
				data-slot="preview-rail-title"
			>
				{item.label}
			</p>
			{item.description ? (
				<div
					className="mt-1 text-muted-foreground text-sm leading-6"
					data-slot="preview-rail-description"
				>
					{item.description}
				</div>
			) : null}
		</div>
	);
}

export function PreviewRail({
	items,
	label = "Section navigation",
	orientation = "vertical",
	activeId,
	defaultActiveId,
	onActiveChange,
	onItemSelect,
	renderPreview,
	showPreview = true,
	previewSide = "after",
	highlightActive = false,
	itemSize = 24,
	children,
	className,
	railClassName,
	previewContainerClassName,
	previewClassName,
}: PreviewRailProps) {
	const uid = useId();
	const reduce = useReducedMotion();
	const canHover = useHoverCapable();
	const [internalActiveId, setInternalActiveId] = useState(
		defaultActiveId ?? items[0]?.id ?? ""
	);
	const [hoveredId, setHoveredId] = useState<string | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);

	const requestedActiveId = activeId ?? internalActiveId;
	const selectedId = items.some((item) => item.id === requestedActiveId)
		? requestedActiveId
		: (items[0]?.id ?? "");
	const displayedId = hoveredId ?? focusedId ?? "";
	const highlightedId = displayedId || (highlightActive ? selectedId : "");
	const displayedIndex = items.findIndex((item) => item.id === highlightedId);
	const rowTemplate = items.length
		? `repeat(${items.length}, ${itemSize}px)`
		: undefined;
	const isHorizontal = orientation === "horizontal";

	const selectItem = (id: string) => {
		if (activeId === undefined) {
			setInternalActiveId(id);
		}
		onActiveChange?.(id);
	};

	const gridStyle: RailStyle = {
		"--rail-columns": isHorizontal ? rowTemplate : undefined,
		"--rail-rows": isHorizontal ? undefined : rowTemplate,
	};
	const itemStyle: RailStyle = {
		"--rail-width": isHorizontal ? `${itemSize}px` : undefined,
		"--rail-height": isHorizontal ? undefined : `${itemSize}px`,
	};

	const previewStyle: RailStyle = {
		"--rail-width": itemStyle["--rail-width"],
		"--rail-height": itemStyle["--rail-height"],
	};

	return (
		<motion.div
			className={cn(
				"relative isolate flex w-full overflow-visible",
				isHorizontal
					? "min-h-64 flex-col items-center justify-center"
					: "min-h-80",
				className
			)}
			layoutRoot
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setFocusedId(null);
				}
			}}
		>
			<nav
				aria-label={label}
				className={[
					css.grid,
					cn(
						"relative z-10 grid shrink-0",
						isHorizontal
							? "h-12 w-fit max-w-full justify-center self-center"
							: "w-12 content-center",
						railClassName
					),
				].join(" ")}
				onPointerLeave={() => setHoveredId(null)}
				style={gridStyle}
			>
				{items.map((item, index) => {
					const selected = item.id === selectedId;
					const highlighted = item.id === highlightedId;
					const distance =
						displayedIndex < 0
							? Number.POSITIVE_INFINITY
							: Math.abs(index - displayedIndex);
					const scale = highlighted
						? 1
						: distance === 1
							? 0.68
							: distance === 2
								? 0.44
								: 0.25;

					const itemContent = (
						<motion.span
							animate={isHorizontal ? { scaleY: scale } : { scaleX: scale }}
							aria-hidden="true"
							className={cn(
								"block bg-current",
								isHorizontal
									? "h-12 w-0.5 origin-bottom"
									: "h-0.5 w-12 origin-left",
								highlighted ? "text-foreground" : undefined
							)}
							data-slot="preview-rail-tick"
							transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
						/>
					);

					const sharedClassName = cn(
						"relative flex text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
						isHorizontal
							? "h-12 w-6 items-end justify-center"
							: "h-6 w-12 items-center"
					);
					const sharedStyle: RailStyle = {
						"--rail-width": itemStyle["--rail-width"],
						"--rail-height": itemStyle["--rail-height"],
					};
					const handlePointerEnter = () => {
						if (canHover) {
							setHoveredId(item.id);
						}
					};
					const handleFocus = (currentTarget: HTMLElement) => {
						if (currentTarget.matches(":focus-visible")) {
							setFocusedId(item.id);
						}
					};
					const handleSelect = () => {
						selectItem(item.id);
						onItemSelect?.(item);
					};
					const safeHref = safeNavigationUrl(item.href);

					return safeHref ? (
						<a
							aria-current={selected ? "page" : undefined}
							aria-label={item.ariaLabel ?? item.label}
							className={[css.item, sharedClassName].join(" ")}
							data-slot="preview-rail-item"
							href={safeHref}
							key={item.id}
							onClick={handleSelect}
							onFocus={(event) => handleFocus(event.currentTarget)}
							onMouseEnter={handlePointerEnter}
							onPointerDown={() => setFocusedId(null)}
							onPointerEnter={handlePointerEnter}
							rel={
								item.rel ??
								(item.target === "_blank" ? "noreferrer noopener" : undefined)
							}
							style={sharedStyle}
							target={item.target}
						>
							{itemContent}
						</a>
					) : (
						<button
							aria-current={selected ? "location" : undefined}
							aria-label={item.ariaLabel ?? item.label}
							className={[css.item, sharedClassName].join(" ")}
							data-slot="preview-rail-item"
							key={item.id}
							onClick={handleSelect}
							onFocus={(event) => handleFocus(event.currentTarget)}
							onMouseEnter={handlePointerEnter}
							onPointerDown={() => setFocusedId(null)}
							onPointerEnter={handlePointerEnter}
							style={sharedStyle}
							type="button"
						>
							{itemContent}
						</button>
					);
				})}
			</nav>

			{showPreview ? (
				<div
					aria-hidden="true"
					className={[
						css.grid,
						cn(
							"pointer-events-none absolute z-50 grid",
							isHorizontal
								? "top-1/2 left-1/2 h-5 w-fit max-w-full -translate-x-1/2 -translate-y-1/2 justify-center"
								: previewSide === "before"
									? "inset-y-0 right-16 left-4 content-center"
									: "inset-y-0 right-4 left-16 content-center",
							previewContainerClassName
						),
					].join(" ")}
					style={gridStyle}
				>
					{items.map((item) => (
						<div
							className={[
								css.item,
								cn(
									"relative flex items-center",
									isHorizontal ? "justify-center" : undefined
								),
							].join(" ")}
							key={item.id}
							style={previewStyle}
						>
							{item.id === displayedId ? (
								<div
									className={cn(
										isHorizontal
											? "absolute bottom-12 left-1/2 w-72 -translate-x-1/2"
											: cn(
													"w-full max-w-sm",
													previewSide === "before" && "ml-auto"
												),
										previewClassName
									)}
								>
									<motion.div
										layoutId={`preview-rail-card-${uid}`}
										transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
									>
										<AnimatePresence initial={false} mode="wait">
											<motion.div
												animate={
													reduce
														? { opacity: 1 }
														: { opacity: 1, y: 0, filter: "blur(0px)" }
												}
												exit={
													reduce
														? { opacity: 0 }
														: {
																opacity: 0,
																y: -2,
																filter: "blur(4px)",
																transition: {
																	duration: 0.12,
																	ease: EASE_OUT,
																},
															}
												}
												initial={
													reduce
														? { opacity: 0 }
														: { opacity: 0, y: 4, filter: "blur(6px)" }
												}
												key={item.id}
												transition={{
													duration: reduce ? 0 : 0.18,
													ease: EASE_OUT,
												}}
											>
												{renderPreview ? (
													renderPreview(item)
												) : (
													<DefaultPreview item={item} />
												)}
											</motion.div>
										</AnimatePresence>
									</motion.div>
								</div>
							) : null}
						</div>
					))}
				</div>
			) : null}

			{children ? (
				<div className="min-h-0 min-w-0 flex-1">{children}</div>
			) : null}
		</motion.div>
	);
}
