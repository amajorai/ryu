"use client";

import {
	Highlight,
	HighlightItem,
} from "@ryu/ui/components/motion-highlight.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva } from "class-variance-authority";
import { ChevronDownIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
	type ComponentPropsWithRef,
	cloneElement,
	createContext,
	type ReactElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

// biome-ignore lint/performance/noNamespaceImport: motion namespace API

interface Spring {
	bounce: number;
	damping?: number;
	stiffness?: number;
	type: "spring";
}

interface ContentRecord {
	children: ReactNode;
	className?: string;
	highlightClassName?: string;
	innerClassName?: string;
}

interface MotionNavigationMenuContextValue {
	activeValue: string;
	closeMenu: () => void;
	direction: number;
	openValue: (value: string) => void;
	registerContent: (value: string, content: ContentRecord) => () => void;
	spring: Spring;
	updateViewportPosition: () => void;
	viewport: boolean;
	viewportX: number | null;
}

interface MotionNavigationMenuItemContextValue {
	value?: string;
}

const MotionNavigationMenuContext =
	createContext<MotionNavigationMenuContextValue | null>(null);

const MotionNavigationMenuItemContext =
	createContext<MotionNavigationMenuItemContextValue | null>(null);

const contentVariants = {
	initial: (direction: number) => ({ x: `${100 * direction}%`, opacity: 0 }),
	active: { x: "0%", opacity: 1 },
	exit: (direction: number) => ({ x: `${-100 * direction}%`, opacity: 0 }),
};

type MotionNavigationMenuProps = Omit<
	ComponentPropsWithRef<"nav">,
	"onValueChange"
> & {
	viewport?: boolean;
	viewportClassName?: string;
	springBounce?: number;
	springStiffness?: number;
	springDamping?: number;
	value?: string;
	onValueChange?: (value: string) => void;
};

function MotionNavigationMenu({
	className,
	children,
	viewport = true,
	viewportClassName,
	springBounce = 0,
	springStiffness = 350,
	springDamping = 32,
	value,
	onValueChange,
	onPointerLeave,
	onKeyDown,
	ref,
	...props
}: MotionNavigationMenuProps) {
	const rootRef = useRef<HTMLElement | null>(null);
	const frameRef = useRef<number | null>(null);
	const lastActiveValueRef = useRef(value ?? "");
	const isControlled = value !== undefined;
	const [internalValue, setInternalValue] = useState("");
	const [direction, setDirection] = useState(1);
	const [viewportX, setViewportX] = useState<number | null>(null);
	const [contentByValue, setContentByValue] = useState<
		Record<string, ContentRecord>
	>({});

	const activeValue = value ?? internalValue;

	const spring = useMemo(
		() => ({
			type: "spring" as const,
			bounce: springBounce,
			stiffness: springStiffness,
			damping: springDamping,
		}),
		[springBounce, springStiffness, springDamping]
	);

	const getItemValues = useCallback(() => {
		const root = rootRef.current;

		if (!root) {
			return [];
		}

		return Array.from(
			root.querySelectorAll<HTMLElement>(
				'[data-slot="navigation-menu-item"][data-value]'
			),
			(item) => item.dataset.value ?? ""
		).filter(Boolean);
	}, []);

	const updateViewportPosition = useCallback(() => {
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current);
		}

		// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy component
		frameRef.current = requestAnimationFrame(() => {
			const root = rootRef.current;

			if (!root) {
				return;
			}

			const rootRect = root.getBoundingClientRect();
			const activeTrigger = root.querySelector<HTMLElement>(
				'[data-slot="navigation-menu-trigger"][data-state="open"]'
			);

			if (!activeTrigger) {
				setViewportX(rootRect.width / 2);
				return;
			}

			const triggerRect = activeTrigger.getBoundingClientRect();
			const idealX = triggerRect.left - rootRect.left + triggerRect.width / 2;

			const measureEl = root.querySelector<HTMLElement>(
				'[data-slot="navigation-menu-measure"]'
			);
			const viewportEl = root.querySelector<HTMLElement>(
				'[data-slot="navigation-menu-viewport"]'
			);
			const contentWidth =
				(measureEl ? measureEl.offsetWidth : 0) ||
				(viewportEl ? viewportEl.offsetWidth : 0);
			const half = contentWidth / 2;

			if (contentWidth > 0) {
				// Find the nearest clipping ancestor to use as the boundary
				let boundary: DOMRect | null = null;
				let ancestor = root.parentElement;
				while (ancestor && ancestor !== document.body) {
					const style = window.getComputedStyle(ancestor);
					const overflow = style.overflow + style.overflowX;
					if (/hidden|clip|scroll|auto/.test(overflow)) {
						boundary = ancestor.getBoundingClientRect();
						break;
					}
					ancestor = ancestor.parentElement;
				}
				if (!boundary) {
					boundary = document.documentElement.getBoundingClientRect();
				}

				const margin = 8;
				const dropLeft = rootRect.left + idealX - half;
				const dropRight = rootRect.left + idealX + half;

				let adjustment = 0;
				if (dropLeft < boundary.left + margin) {
					adjustment = boundary.left + margin - dropLeft;
				} else if (dropRight > boundary.right - margin) {
					adjustment = boundary.right - margin - dropRight;
				}

				setViewportX(idealX + adjustment);
			} else {
				setViewportX(idealX);
			}
		});
	}, []);

	const setRootRef = useCallback(
		(node: HTMLElement | null) => {
			rootRef.current = node;

			if (typeof ref === "function") {
				ref(node);
			} else if (ref) {
				ref.current = node;
			}
		},
		[ref]
	);

	const setActiveValue = useCallback(
		(nextValue: string) => {
			if (!isControlled) {
				setInternalValue(nextValue);
			}

			onValueChange?.(nextValue);
		},
		[isControlled, onValueChange]
	);

	const openValue = useCallback(
		(nextValue: string) => {
			if (!nextValue || nextValue === lastActiveValueRef.current) {
				return;
			}

			const itemValues = getItemValues();
			const previousIndex = itemValues.indexOf(lastActiveValueRef.current);
			const nextIndex = itemValues.indexOf(nextValue);

			if (previousIndex !== -1 && nextIndex !== -1) {
				setDirection(nextIndex > previousIndex ? 1 : -1);
			}

			lastActiveValueRef.current = nextValue;
			setActiveValue(nextValue);
			updateViewportPosition();
		},
		[getItemValues, setActiveValue, updateViewportPosition]
	);

	const closeMenu = useCallback(() => {
		lastActiveValueRef.current = "";
		setActiveValue("");
		updateViewportPosition();
	}, [setActiveValue, updateViewportPosition]);

	const registerContent = useCallback(
		(contentValue: string, content: ContentRecord) => {
			setContentByValue((current) => {
				const previous = current[contentValue];

				if (
					previous?.children === content.children &&
					previous?.className === content.className &&
					previous?.innerClassName === content.innerClassName
				) {
					return current;
				}

				return { ...current, [contentValue]: content };
			});

			return () => {
				setContentByValue((current) => {
					if (!current[contentValue]) {
						return current;
					}

					const next = { ...current };
					delete next[contentValue];
					return next;
				});
			};
		},
		[]
	);

	useEffect(() => {
		if (value === undefined) {
			return;
		}

		if (!value) {
			lastActiveValueRef.current = "";
			return;
		}

		openValue(value);
	}, [openValue, value]);

	useLayoutEffect(() => {
		updateViewportPosition();
		// biome-ignore lint/correctness/useExhaustiveDependencies: reposition whenever the active menu changes
	}, [updateViewportPosition]);

	useLayoutEffect(() => {
		const root = rootRef.current;

		if (!root || typeof ResizeObserver === "undefined") {
			return () => {
				if (frameRef.current !== null) {
					cancelAnimationFrame(frameRef.current);
				}
			};
		}

		const observer = new ResizeObserver(updateViewportPosition);
		observer.observe(root);

		return () => {
			observer.disconnect();

			if (frameRef.current !== null) {
				cancelAnimationFrame(frameRef.current);
			}
		};
	}, [updateViewportPosition]);

	useEffect(() => {
		function handlePointerDown(event: PointerEvent) {
			if (
				rootRef.current &&
				event.target instanceof Node &&
				!rootRef.current.contains(event.target)
			) {
				closeMenu();
			}
		}

		document.addEventListener("pointerdown", handlePointerDown);
		return () => document.removeEventListener("pointerdown", handlePointerDown);
	}, [closeMenu]);

	const contextValue = useMemo(
		() => ({
			activeValue,
			direction,
			spring,
			viewport,
			viewportX,
			openValue,
			closeMenu,
			registerContent,
			updateViewportPosition,
		}),
		[
			activeValue,
			closeMenu,
			direction,
			openValue,
			registerContent,
			spring,
			updateViewportPosition,
			viewport,
			viewportX,
		]
	);

	return (
		<MotionNavigationMenuContext.Provider value={contextValue}>
			{/* biome-ignore lint/a11y/useSemanticElements: nav is the semantic element here */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/noNoninteractiveElementInteractions: custom drag/resize interaction */}
			<nav
				className={cn(
					"group/navigation-menu relative flex max-w-max flex-1 items-center justify-center",
					className
				)}
				data-slot="navigation-menu"
				data-viewport={viewport}
				onKeyDown={(event) => {
					onKeyDown?.(event);

					if (event.key === "Escape") {
						closeMenu();
					}
				}}
				onPointerLeave={(event) => {
					onPointerLeave?.(event);
					closeMenu();
				}}
				ref={setRootRef}
				{...props}
			>
				{children}
				{viewport && (
					<MotionNavigationMenuViewport
						className={viewportClassName}
						contentByValue={contentByValue}
					/>
				)}
			</nav>
		</MotionNavigationMenuContext.Provider>
	);
}

function MotionNavigationMenuList({
	className,
	highlightClassName,
	...props
}: ComponentPropsWithRef<"ul"> & {
	highlightClassName?: string;
}) {
	return (
		<Highlight
			className={cn(
				"pointer-events-none rounded-full bg-accent",
				highlightClassName
			)}
			containerClassName="relative"
			controlledItems
			hover
			mode="parent"
			style={{ zIndex: -1 }}
		>
			<ul
				className={cn(
					"group relative z-10 flex flex-1 list-none items-center justify-center gap-1",
					className
				)}
				data-slot="navigation-menu-list"
				{...props}
			/>
		</Highlight>
	);
}

function MotionNavigationMenuItem({
	className,
	value,
	...props
}: ComponentPropsWithRef<"li"> & {
	value?: string;
}) {
	const itemContextValue = useMemo(() => ({ value }), [value]);

	return (
		<MotionNavigationMenuItemContext.Provider value={itemContextValue}>
			<li
				className={cn("relative", className)}
				data-slot="navigation-menu-item"
				data-value={value}
				{...props}
			/>
		</MotionNavigationMenuItemContext.Provider>
	);
}

const motionNavigationMenuTriggerStyle = cva(
	"group inline-flex h-9 w-max items-center justify-center rounded-full bg-transparent px-3 py-2 font-medium text-sm outline-none transition-colors hover:text-accent-foreground focus:text-accent-foreground focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 data-[state=open]:text-accent-foreground"
);

function MotionNavigationMenuTrigger({
	className,
	children,
	onPointerEnter,
	onFocus,
	onClick,
	...props
}: ComponentPropsWithRef<"button">) {
	const context = useContext(MotionNavigationMenuContext);
	const itemContext = useContext(MotionNavigationMenuItemContext);
	const value = itemContext?.value;
	const isOpen = !!value && context?.activeValue === value;

	return (
		<HighlightItem asChild>
			<button
				aria-expanded={isOpen}
				className={cn(motionNavigationMenuTriggerStyle(), "group", className)}
				data-slot="navigation-menu-trigger"
				data-state={isOpen ? "open" : "closed"}
				onClick={(event) => {
					onClick?.(event);

					if (value) {
						context?.openValue(value);
					}
				}}
				onFocus={(event) => {
					onFocus?.(event);

					if (value) {
						context?.openValue(value);
					}
				}}
				onPointerEnter={(event) => {
					onPointerEnter?.(event);

					if (value) {
						context?.openValue(value);
					}
				}}
				type="button"
				{...props}
			>
				{children}{" "}
				<motion.span
					animate={{
						rotate: isOpen ? 180 : 0,
						y: isOpen ? 1 : 0,
					}}
					aria-hidden="true"
					className="relative top-0 ml-1.5 inline-flex"
					transition={{
						type: "spring",
						stiffness: 400,
						damping: 20,
					}}
				>
					<ChevronDownIcon aria-hidden="true" className="size-3.5 stroke-2" />
				</motion.span>
			</button>
		</HighlightItem>
	);
}

function MotionNavigationMenuContent({
	className,
	highlightClassName,
	innerClassName,
	children,
}: ComponentPropsWithRef<"div"> & {
	highlightClassName?: string;
	innerClassName?: string;
}) {
	const context = useContext(MotionNavigationMenuContext);
	const itemContext = useContext(MotionNavigationMenuItemContext);
	const value = itemContext?.value;
	const isOpen = !!value && context?.activeValue === value;

	useLayoutEffect(() => {
		if (!(context && value && context.viewport)) {
			return;
		}

		return context.registerContent(value, {
			children,
			className,
			highlightClassName,
			innerClassName,
		});
	}, [children, className, context, highlightClassName, innerClassName, value]);

	if (!(context && value) || context.viewport) {
		return null;
	}

	return (
		<AnimatePresence custom={context.direction} initial={false}>
			{isOpen && (
				<motion.div
					animate="active"
					className={cn(
						"absolute top-full left-0 z-50 mt-1.5 rounded-2xl border border-border/60 bg-muted/80 p-2 pr-2.5 text-popover-foreground shadow-lg backdrop-blur-xl",
						className
					)}
					custom={context.direction}
					data-slot="navigation-menu-content"
					exit="exit"
					initial="initial"
					key={value}
					transition={context.spring}
					variants={contentVariants}
				>
					<MotionNavigationMenuContentInner
						highlightClassName={highlightClassName}
						innerClassName={innerClassName}
					>
						{children}
					</MotionNavigationMenuContentInner>
				</motion.div>
			)}
		</AnimatePresence>
	);
}

function MotionNavigationMenuContentInner({
	highlightClassName,
	innerClassName,
	children,
}: {
	highlightClassName?: string;
	innerClassName?: string;
	children: ReactNode;
}) {
	return (
		<Highlight
			className={cn(
				"pointer-events-none rounded-sm bg-accent",
				highlightClassName
			)}
			containerClassName="relative"
			controlledItems
			hover
			mode="parent"
			style={{ zIndex: -1 }}
		>
			<div className={cn("relative z-10", innerClassName)}>{children}</div>
		</Highlight>
	);
}

function MotionNavigationMenuViewport({
	className,
	contentByValue,
}: ComponentPropsWithRef<"div"> & {
	contentByValue?: Record<string, ContentRecord>;
}) {
	const context = useContext(MotionNavigationMenuContext);
	const measureRef = useRef<HTMLDivElement | null>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [lastSize, setLastSize] = useState({ width: 0, height: 0 });
	const activeContent =
		context?.activeValue && contentByValue
			? contentByValue[context.activeValue]
			: undefined;

	useLayoutEffect(() => {
		const node = measureRef.current;

		if (!(node && activeContent)) {
			return;
		}

		const updateSize = () => {
			const rect = node.getBoundingClientRect();
			const nextSize = {
				width: rect.width,
				height: rect.height,
			};

			setSize(nextSize);

			if (nextSize.width > 0 || nextSize.height > 0) {
				setLastSize(nextSize);
			}

			context?.updateViewportPosition();
		};

		updateSize();

		if (typeof ResizeObserver === "undefined") {
			return;
		}

		const observer = new ResizeObserver(updateSize);
		observer.observe(node);

		return () => observer.disconnect();
	}, [activeContent, context]);

	const width = size.width > 0 ? size.width : lastSize.width;
	const height = size.height > 0 ? size.height : lastSize.height;

	return (
		<motion.div
			animate={{ left: context?.viewportX ?? "50%" }}
			className="absolute top-full isolate z-50 flex -translate-x-1/2 justify-center"
			initial={false}
			transition={context?.spring}
		>
			<motion.div
				animate={{
					width: activeContent ? width : 0,
					height: activeContent ? height : 0,
					opacity: activeContent ? 1 : 0,
					scale: activeContent ? 1 : 0.95,
				}}
				className={cn(
					"relative mt-1.5 overflow-hidden rounded-2xl border border-border/60 bg-muted/80 text-popover-foreground shadow-lg backdrop-blur-xl",
					className
				)}
				data-slot="navigation-menu-viewport"
				initial={false}
				transition={context?.spring}
			>
				<AnimatePresence
					custom={context?.direction ?? 1}
					initial={false}
					mode="popLayout"
				>
					{activeContent && context?.activeValue && (
						<motion.div
							animate="active"
							className={cn("p-2 pr-2.5", activeContent.className)}
							custom={context.direction}
							data-slot="navigation-menu-content"
							exit="exit"
							initial="initial"
							key={context.activeValue}
							transition={context.spring}
							variants={contentVariants}
						>
							<MotionNavigationMenuContentInner
								highlightClassName={activeContent.highlightClassName}
								innerClassName={activeContent.innerClassName}
							>
								{activeContent.children}
							</MotionNavigationMenuContentInner>
						</motion.div>
					)}
				</AnimatePresence>
			</motion.div>

			<div
				aria-hidden="true"
				className="pointer-events-none invisible absolute top-1.5 left-0 w-max"
				data-slot="navigation-menu-measure"
				ref={measureRef}
			>
				{activeContent && (
					<div className={cn("p-2 pr-2.5", activeContent.className)}>
						<MotionNavigationMenuContentInner
							highlightClassName={activeContent.highlightClassName}
							innerClassName={activeContent.innerClassName}
						>
							{activeContent.children}
						</MotionNavigationMenuContentInner>
					</div>
				)}
			</div>
		</motion.div>
	);
}

function MotionNavigationMenuLink({
	className,
	render,
	...props
}: ComponentPropsWithRef<"a"> & {
	/** Base-UI-style escape hatch: render this element (e.g. a Next.js `<Link>`)
	 * instead of a bare `<a>`, preserving client-side navigation. */
	render?: ReactElement<{ className?: string }>;
}) {
	const linkClassName = cn(
		"flex flex-col gap-1 rounded-sm p-2 text-sm outline-none transition-colors hover:text-accent-foreground focus:text-accent-foreground focus-visible:outline-1 focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[active=true]:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
		className
	);

	const child = render ? (
		cloneElement(render, {
			...props,
			className: cn(linkClassName, render.props.className),
			"data-slot": "navigation-menu-link",
		} as Record<string, unknown>)
	) : (
		<a className={linkClassName} data-slot="navigation-menu-link" {...props} />
	);

	return <HighlightItem asChild>{child}</HighlightItem>;
}

function MotionNavigationMenuIndicator({
	className,
	...props
}: ComponentPropsWithRef<"div">) {
	return (
		<div
			className={cn(
				"pointer-events-none top-full z-1 flex h-1.5 items-end justify-center overflow-hidden",
				className
			)}
			data-slot="navigation-menu-indicator"
			{...props}
		>
			<div className="relative top-[60%] h-2 w-2 rotate-45 rounded-tl-sm bg-border shadow-md" />
		</div>
	);
}

export {
	MotionNavigationMenu,
	MotionNavigationMenuContent,
	MotionNavigationMenuIndicator,
	MotionNavigationMenuItem,
	MotionNavigationMenuLink,
	MotionNavigationMenuList,
	MotionNavigationMenuTrigger,
	MotionNavigationMenuViewport,
	motionNavigationMenuTriggerStyle,
};
