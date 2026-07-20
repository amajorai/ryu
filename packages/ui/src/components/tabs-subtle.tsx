"use client";

import { Tabs } from "@base-ui/react/tabs";
import { useProximityHover } from "@ryu/ui/hooks/use-proximity-hover.ts";
import { fontWeights } from "@ryu/ui/lib/font-weight.ts";
import { spring } from "@ryu/ui/lib/springs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { AnimatePresence, motion } from "motion/react";
import {
	type ComponentType,
	createContext,
	forwardRef,
	type HTMLAttributes,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

// A lucide-shaped icon component: called with `size`/`strokeWidth`/`className`.
// Kept local so the tabs don't drag in a full icon-library map just for a type —
// any icon that renders from these props (lucide, or a hugeicons adapter) fits.
export type IconComponent = ComponentType<{
	size?: number;
	strokeWidth?: number;
	className?: string;
}>;

// Rounded shape tokens for the selection pill and the focus ring. The upstream
// registry sources these from a swappable "shape context"; we inline the
// rounded variant to match the rest of the design system.
const SHAPE_BG = "rounded-lg";
const SHAPE_FOCUS = "rounded-[10px]";

interface TabsSubtleContextValue {
	activeLabel: boolean;
	hoveredIndex: number | null;
	idPrefix: string | undefined;
	registerTab: (index: number, element: HTMLElement | null) => void;
	selectedIndex: number;
}

const TabsSubtleContext = createContext<TabsSubtleContextValue | null>(null);

function useTabsSubtle() {
	const ctx = useContext(TabsSubtleContext);
	if (!ctx) {
		throw new Error("useTabsSubtle must be used within a TabsSubtle");
	}
	return ctx;
}

interface TabsSubtleProps
	extends Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> {
	/** When true, only the selected tab shows its text label. Requires icons on tabs. */
	activeLabel?: boolean;
	children: ReactNode;
	idPrefix?: string;
	onSelect: (index: number) => void;
	selectedIndex: number;
}

const TabsSubtle = forwardRef<HTMLDivElement, TabsSubtleProps>(
	(
		{
			children,
			selectedIndex,
			onSelect,
			idPrefix,
			activeLabel = false,
			className,
			...props
		},
		ref
	) => {
		const containerRef = useRef<HTMLDivElement>(null);
		const isMouseInside = useRef(false);

		const {
			activeIndex: hoveredIndex,
			setActiveIndex: setHoveredIndex,
			itemRects: tabRects,
			handlers,
			registerItem,
			measureItems: measureTabs,
		} = useProximityHover(containerRef, { axis: "x" });

		// Track tab elements locally so we can observe their individual resizes
		const tabElementsRef = useRef(new Map<number, HTMLElement>());
		const registerTab = useCallback(
			(index: number, element: HTMLElement | null) => {
				registerItem(index, element);
				if (element) {
					tabElementsRef.current.set(index, element);
				} else {
					tabElementsRef.current.delete(index);
				}
			},
			[registerItem]
		);

		useEffect(() => {
			measureTabs();
		}, [measureTabs, children]);

		// Observe individual tab buttons for resize (label expand/collapse in activeLabel mode)
		useEffect(() => {
			const elements = tabElementsRef.current;
			if (elements.size === 0) {
				return;
			}
			const ro = new ResizeObserver(() => measureTabs());
			elements.forEach((el) => ro.observe(el));
			return () => ro.disconnect();
		}, [measureTabs, children]);

		// Wrap handlers to track isMouseInside
		const handleMouseMove = useCallback(
			(e: React.MouseEvent) => {
				isMouseInside.current = true;
				handlers.onMouseMove(e);
			},
			[handlers]
		);

		const handleMouseLeave = useCallback(() => {
			isMouseInside.current = false;
			handlers.onMouseLeave();
		}, [handlers]);

		const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

		const selectedRect = tabRects[selectedIndex];
		const hoverRect = hoveredIndex === null ? null : tabRects[hoveredIndex];
		const focusRect = focusedIndex === null ? null : tabRects[focusedIndex];
		const isHoveringSelected = hoveredIndex === selectedIndex;
		const isHovering = hoveredIndex !== null && !isHoveringSelected;

		return (
			<TabsSubtleContext.Provider
				value={{
					registerTab,
					hoveredIndex,
					selectedIndex,
					idPrefix,
					activeLabel,
				}}
			>
				{/* Root is merged into List via `render` so a single <div> is emitted,
            matching the previous DOM structure. Base UI owns role="tablist",
            roving tabindex, and Arrow/Home/End keyboard navigation.
            `activateOnFocus={false}` keeps manual activation: arrows move
            focus, Enter/Space selects. */}
				<Tabs.Root
					onValueChange={(value) => {
						if (typeof value === "number") {
							onSelect(value);
						}
					}}
					render={
						<Tabs.List
							activateOnFocus={false}
							className={cn(
								// -mx-1 px-1 / -my-1 py-1 give the 2px-outset focus ring room
								// to draw without being clipped by overflow-x-auto
								"scrollbar-hide relative -mx-1 -my-1 flex max-w-full select-none items-center gap-0.5 overflow-x-auto px-1 py-1",
								className
							)}
							onBlur={(e: React.FocusEvent<HTMLDivElement>) => {
								if (containerRef.current?.contains(e.relatedTarget as Node)) {
									return;
								}
								setFocusedIndex(null);
								if (isMouseInside.current) {
									return;
								}
								setHoveredIndex(null);
							}}
							onFocus={(e: React.FocusEvent<HTMLDivElement>) => {
								const indexAttr = (e.target as HTMLElement)
									.closest("[data-proximity-index]")
									?.getAttribute("data-proximity-index");
								if (indexAttr != null) {
									const idx = Number(indexAttr);
									setHoveredIndex(idx);
									setFocusedIndex(
										(e.target as HTMLElement).matches(":focus-visible")
											? idx
											: null
									);
								}
							}}
							onMouseLeave={handleMouseLeave}
							onMouseMove={handleMouseMove}
							ref={(node: HTMLDivElement | null) => {
								containerRef.current = node;
								if (typeof ref === "function") {
									ref(node);
								} else if (ref) {
									(
										ref as React.MutableRefObject<HTMLDivElement | null>
									).current = node;
								}
							}}
							{...props}
						>
							{/* Selected pill */}
							{selectedRect && (
								<motion.div
									animate={{
										left: selectedRect.left,
										width: selectedRect.width,
										top: selectedRect.top,
										height: selectedRect.height,
										opacity: isHovering ? 0.8 : 1,
									}}
									className={cn(
										"pointer-events-none absolute bg-accent",
										SHAPE_BG
									)}
									initial={false}
									transition={{
										...spring.moderate,
										opacity: { duration: 0.08 },
									}}
								/>
							)}

							{/* Hover pill */}
							<AnimatePresence>
								{hoverRect && !isHoveringSelected && selectedRect && (
									<motion.div
										animate={{
											left: hoverRect.left,
											width: hoverRect.width,
											top: hoverRect.top,
											height: hoverRect.height,
											opacity: 0.4,
										}}
										className={cn(
											"pointer-events-none absolute bg-accent",
											SHAPE_BG
										)}
										exit={
											isMouseInside.current
												? { opacity: 0, transition: spring.fast.exit }
												: {
														left: selectedRect.left,
														width: selectedRect.width,
														top: selectedRect.top,
														height: selectedRect.height,
														opacity: 0,
														transition: {
															...spring.moderate,
															opacity: { duration: 0.06 },
														},
													}
										}
										initial={{
											left: selectedRect.left,
											width: selectedRect.width,
											top: selectedRect.top,
											height: selectedRect.height,
											opacity: 0,
										}}
										transition={{
											...spring.fast,
											opacity: { duration: 0.08 },
										}}
									/>
								)}
							</AnimatePresence>

							{/* Focus ring */}
							<AnimatePresence>
								{focusRect && (
									<motion.div
										animate={{
											left: focusRect.left - 2,
											top: focusRect.top - 2,
											width: focusRect.width + 4,
											height: focusRect.height + 4,
										}}
										className={cn(
											"pointer-events-none absolute z-20 border border-[color:var(--focus-ring,#6B97FF)]",
											SHAPE_FOCUS
										)}
										exit={{ opacity: 0, transition: spring.fast.exit }}
										initial={false}
										transition={{
											...spring.fast,
											opacity: { duration: 0.08 },
										}}
									/>
								)}
							</AnimatePresence>

							{children}
						</Tabs.List>
					}
					value={selectedIndex}
				/>
			</TabsSubtleContext.Provider>
		);
	}
);

TabsSubtle.displayName = "TabsSubtle";

interface TabsSubtleItemProps extends HTMLAttributes<HTMLButtonElement> {
	icon?: IconComponent;
	index: number;
	label: string;
}

const TabsSubtleItem = forwardRef<HTMLButtonElement, TabsSubtleItemProps>(
	({ icon: Icon, label, index, className, ...props }, ref) => {
		const internalRef = useRef<HTMLButtonElement | null>(null);
		const { registerTab, hoveredIndex, selectedIndex, idPrefix, activeLabel } =
			useTabsSubtle();

		useEffect(() => {
			registerTab(index, internalRef.current);
			return () => registerTab(index, null);
		}, [index, registerTab]);

		const isSelected = selectedIndex === index;
		const isActive = hoveredIndex === index || isSelected;
		const collapseLabel = activeLabel && !!Icon;
		const showLabel = !collapseLabel || isSelected;

		const labelContent = (
			// Both stacked spans carry the text-box trim so the invisible bold
			// sizer and the visible label keep identical boxes.
			<span className="inline-grid whitespace-nowrap text-[13px]">
				<span
					aria-hidden="true"
					className="invisible col-start-1 row-start-1 [text-box:trim-both_cap_alphabetic]"
					style={{ fontVariationSettings: fontWeights.semibold }}
				>
					{label}
				</span>
				<span
					className={cn(
						"col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic]",
						isActive ? "text-foreground" : "text-muted-foreground"
					)}
					style={{
						fontVariationSettings: isSelected
							? fontWeights.semibold
							: fontWeights.normal,
					}}
				>
					{label}
				</span>
			</span>
		);

		return (
			// Base UI Tab renders a native <button type="button"> and wires
			// role="tab", aria-selected, roving tabindex, and activation for us.
			// id/aria-controls are only overridden when an idPrefix is supplied so
			// externally rendered TabsSubtlePanel elements stay linked.
			<Tabs.Tab
				aria-controls={idPrefix ? `${idPrefix}-panel-${index}` : undefined}
				aria-label={collapseLabel && !showLabel ? label : undefined}
				className={cn(
					// Fixed heights (was py-2 around a 19.5px line box ≈ 35.5px) so the
					// text-box trim on the label doesn't shrink the tab.
					"relative z-10 flex cursor-pointer items-center border-none bg-transparent px-3 outline-none",
					collapseLabel ? "h-8" : "h-9 gap-2",
					SHAPE_BG,
					className
				)}
				data-proximity-index={index}
				id={idPrefix ? `${idPrefix}-tab-${index}` : undefined}
				ref={(node: HTMLElement | null) => {
					const button = node as HTMLButtonElement | null;
					internalRef.current = button;
					if (typeof ref === "function") {
						ref(button);
					} else if (ref) {
						(ref as React.MutableRefObject<HTMLButtonElement | null>).current =
							button;
					}
				}}
				value={index}
				{...props}
			>
				{Icon && (
					<Icon
						className={cn(
							"shrink-0 transition-[color,stroke-width] duration-80",
							isActive ? "text-foreground" : "text-muted-foreground"
						)}
						size={16}
						strokeWidth={isActive ? 2 : 1.5}
					/>
				)}
				{collapseLabel ? (
					<AnimatePresence initial={false}>
						{showLabel && (
							<motion.span
								animate={{ width: "auto", opacity: 1, marginLeft: 8 }}
								className="overflow-hidden"
								exit={{ width: 0, opacity: 0, marginLeft: 0 }}
								initial={{ width: 0, opacity: 0, marginLeft: 0 }}
								key="label"
								transition={{
									...spring.fast,
									opacity: { duration: 0.06 },
								}}
							>
								{labelContent}
							</motion.span>
						)}
					</AnimatePresence>
				) : (
					labelContent
				)}
			</Tabs.Tab>
		);
	}
);

TabsSubtleItem.displayName = "TabsSubtleItem";

interface TabsSubtlePanelProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
	idPrefix: string;
	index: number;
	selectedIndex: number;
}

// Rendered outside <TabsSubtle> at every call site, so it cannot use Base UI's
// Tabs.Panel (which requires the Tabs.Root context). It stays a plain tabpanel
// linked to its tab through the shared idPrefix.
const TabsSubtlePanel = forwardRef<HTMLDivElement, TabsSubtlePanelProps>(
	({ index, selectedIndex, idPrefix, children, className, ...props }, ref) => {
		const isSelected = selectedIndex === index;

		return (
			<div
				aria-labelledby={`${idPrefix}-tab-${index}`}
				className={cn("outline-none", className)}
				hidden={!isSelected}
				id={`${idPrefix}-panel-${index}`}
				ref={ref}
				role="tabpanel"
				tabIndex={-1}
				{...props}
			>
				{isSelected && children}
			</div>
		);
	}
);

TabsSubtlePanel.displayName = "TabsSubtlePanel";

export { TabsSubtle, TabsSubtleItem, TabsSubtlePanel };
export default TabsSubtle;
