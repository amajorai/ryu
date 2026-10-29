"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import {
	AnimatePresence,
	motion,
	type TargetAndTransition,
	type Transition,
} from "motion/react";
import {
	Children,
	type ComponentProps,
	cloneElement,
	createContext,
	createElement,
	isValidElement,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
	type Ref,
	type RefCallback,
	useCallback,
	useContext,
	useEffect,
	useId,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { isNativeFunction } from "../lib/native-primitive-observation.ts";

type HighlightMode = "children" | "parent";

interface Bounds {
	height: number;
	left: number;
	top: number;
	width: number;
}

function isSameBounds(previous: Bounds | null, next: Bounds): boolean {
	return (
		previous !== null &&
		previous.top === next.top &&
		previous.left === next.left &&
		previous.width === next.width &&
		previous.height === next.height
	);
}

/** Fade the highlight out on its own transition, held back by `exitDelay`. */
function delayedFadeOut(
	transition: Transition | undefined,
	exitDelay: number
): TargetAndTransition {
	return {
		opacity: 0,
		transition: {
			...transition,
			delay: (transition?.delay ?? 0) + exitDelay,
		},
	};
}

interface HighlightContextType<T extends string> {
	activeClassName?: string;
	activeValue: T | null;
	className?: string;
	clearBounds: () => void;
	disabled?: boolean;
	enabled?: boolean;
	exitDelay?: number;
	forceUpdateBounds?: boolean;
	hover: boolean;
	id: string;
	mode: HighlightMode;
	setActiveClassName: (className: string) => void;
	setActiveValue: (value: T | null) => void;
	setBounds: (bounds: DOMRect) => void;
	transition?: Transition;
}

const HighlightContext = createContext<
	HighlightContextType<string> | undefined
>(undefined);

function useHighlight<T extends string = string>(): HighlightContextType<T> {
	const context = useContext(HighlightContext);
	if (!context) {
		throw new Error("useHighlight must be used within a HighlightProvider");
	}
	// SAFETY: Provider and consumer share the item identifier domain T; the non-generic React context erases only that identifier type.
	const activeValue = context.activeValue as T | null;
	return { ...context, activeValue };
}

interface BaseHighlightProps<T extends string> {
	className?: string;
	defaultValue?: T | null;
	disabled?: boolean;
	enabled?: boolean;
	exitDelay?: number;
	hover?: boolean;
	mode?: HighlightMode;
	onValueChange?: (value: T | null) => void;
	transition?: Transition;
	value?: T | null;
}

interface ParentModeHighlightProps {
	boundsOffset?: Partial<Bounds>;
	containerClassName?: string;
	forceUpdateBounds?: boolean;
}

type ControlledParentModeHighlightProps<T extends string> =
	BaseHighlightProps<T> &
		ParentModeHighlightProps & {
			mode: "parent";
			controlledItems: true;
			children: ReactNode;
		};

type ControlledChildrenModeHighlightProps<T extends string> =
	BaseHighlightProps<T> & {
		mode?: "children" | undefined;
		controlledItems: true;
		children: ReactNode;
	};

type UncontrolledParentModeHighlightProps<T extends string> =
	BaseHighlightProps<T> &
		ParentModeHighlightProps & {
			mode: "parent";
			controlledItems?: false;
			itemsClassName?: string;
			children: ReactElement | ReactElement[];
		};

type UncontrolledChildrenModeHighlightProps<T extends string> =
	BaseHighlightProps<T> & {
		mode?: "children";
		controlledItems?: false;
		itemsClassName?: string;
		children: ReactElement | ReactElement[];
	};

type HighlightProps<T extends string> = ComponentProps<"div"> &
	ParentModeHighlightProps & { itemsClassName?: string } & (
		| ControlledParentModeHighlightProps<T>
		| ControlledChildrenModeHighlightProps<T>
		| UncontrolledParentModeHighlightProps<T>
		| UncontrolledChildrenModeHighlightProps<T>
	);

function Highlight<T extends string>({ ref, ...props }: HighlightProps<T>) {
	const {
		children,
		value,
		defaultValue,
		onValueChange,
		className,
		transition = { type: "spring", stiffness: 350, damping: 35 },
		hover = false,
		enabled = true,
		controlledItems,
		disabled = false,
		exitDelay = 0.2,
		mode = "children",
	} = props;
	const {
		boundsOffset = { top: 0, left: 0, width: 0, height: 0 },
		containerClassName,
		forceUpdateBounds,
	} = props;
	const { itemsClassName } = props;

	const localRef = useRef<HTMLDivElement>(null);
	useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(
		ref,
		() => localRef.current
	);

	const [activeValue, setActiveValue] = useState<T | null>(
		value ?? defaultValue ?? null
	);
	const [boundsState, setBoundsState] = useState<Bounds | null>(null);
	const [activeClassNameState, setActiveClassNameState] = useState<string>("");

	function safeSetActiveValue(id: string | null) {
		setActiveValue((prev) => {
			if (prev !== id) {
				// SAFETY: HighlightItem identifiers belong to the provider's T domain, which the non-generic React context erases.
				onValueChange?.(id as T);
			}
			// SAFETY: The context forwards the provider's item identifier domain or null.
			return prev === id ? prev : (id as T | null);
		});
	}

	function safeSetBounds(bounds: DOMRect) {
		if (!localRef.current) {
			return;
		}

		const containerRect = localRef.current.getBoundingClientRect();
		const newBounds: Bounds = {
			top: bounds.top - containerRect.top + (boundsOffset.top ?? 0),
			left: bounds.left - containerRect.left + (boundsOffset.left ?? 0),
			width: bounds.width + (boundsOffset.width ?? 0),
			height: bounds.height + (boundsOffset.height ?? 0),
		};

		setBoundsState((prev) =>
			isSameBounds(prev, newBounds) ? prev : newBounds
		);
	}

	function clearBounds() {
		setBoundsState((prev) => (prev === null ? prev : null));
	}

	useEffect(() => {
		if (value !== undefined) {
			setActiveValue(value);
		} else if (defaultValue !== undefined) {
			setActiveValue(defaultValue);
		}
	}, [value, defaultValue]);

	const id = useId();

	useEffect(() => {
		if (mode !== "parent") {
			return;
		}
		const container = localRef.current;
		if (!container) {
			return;
		}

		const onScroll = () => {
			if (!activeValue) {
				return;
			}
			const activeEl = container.querySelector<HTMLElement>(
				`[data-value="${activeValue}"][data-highlight="true"]`
			);
			if (activeEl) {
				safeSetBounds(activeEl.getBoundingClientRect());
			}
		};

		container.addEventListener("scroll", onScroll, { passive: true });
		return () => container.removeEventListener("scroll", onScroll);
	});

	function render(nodeChildren: ReactNode) {
		if (mode === "parent") {
			return (
				<div
					className={cn("relative", containerClassName)}
					data-slot="motion-highlight-container"
					ref={localRef}
				>
					<AnimatePresence initial={false}>
						{boundsState && (
							<motion.div
								animate={{ ...boundsState, opacity: 1 }}
								className={cn(
									"absolute z-0 bg-muted",
									className,
									activeClassNameState
								)}
								data-slot="motion-highlight"
								exit={delayedFadeOut(transition, exitDelay ?? 0)}
								initial={{ ...boundsState, opacity: 0 }}
								transition={transition}
							/>
						)}
					</AnimatePresence>
					{nodeChildren}
				</div>
			);
		}

		return nodeChildren;
	}

	return (
		<HighlightContext.Provider
			value={{
				mode,
				activeValue,
				setActiveValue: safeSetActiveValue,
				id,
				hover,
				className,
				transition,
				disabled,
				enabled,
				exitDelay,
				setBounds: safeSetBounds,
				clearBounds,
				activeClassName: activeClassNameState,
				setActiveClassName: setActiveClassNameState,
				forceUpdateBounds,
			}}
		>
			{enabled
				? controlledItems
					? render(children)
					: render(
							Children.map(children, (child, index) =>
								isValidElement<{ id?: string }>(child) ? (
									<HighlightItem
										className={itemsClassName}
										key={child.props?.id ?? index}
									>
										{child}
									</HighlightItem>
								) : (
									child
								)
							)
						)
				: children}
		</HighlightContext.Provider>
	);
}

type HighlightDataAttributes = Pick<
	ExtendedChildProps,
	| "data-active"
	| "data-disabled"
	| "data-value"
	| "data-highlight"
	| "data-slot"
	| "aria-selected"
>;
function getNonOverridingDataAttributes(
	element: ReactElement<ExtendedChildProps>,
	dataAttributes: HighlightDataAttributes
): HighlightDataAttributes {
	const result: HighlightDataAttributes = {};
	if (element.props["data-active"] === undefined) {
		result["data-active"] = dataAttributes["data-active"];
	}
	if (element.props["data-disabled"] === undefined) {
		result["data-disabled"] = dataAttributes["data-disabled"];
	}
	if (element.props["data-value"] === undefined) {
		result["data-value"] = dataAttributes["data-value"];
	}
	if (element.props["data-highlight"] === undefined) {
		result["data-highlight"] = dataAttributes["data-highlight"];
	}
	if (element.props["aria-selected"] === undefined) {
		result["aria-selected"] = dataAttributes["aria-selected"];
	}
	if (element.props["data-slot"] === undefined) {
		result["data-slot"] = dataAttributes["data-slot"];
	}
	return result;
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
	if (!ref) {
		return;
	}
	if (isNativeFunction(ref)) {
		ref(node);
		return;
	}
	ref.current = node;
}

function useComposedRefs<T>(
	childRef: Ref<T> | undefined,
	localRef: Ref<T> | undefined,
	forwardedRef: Ref<T> | undefined
): RefCallback<T> {
	return useCallback(
		(node) => {
			assignRef(childRef, node);
			assignRef(localRef, node);
			assignRef(forwardedRef, node);
		},
		[childRef, localRef, forwardedRef]
	);
}

type ExtendedChildProps = ComponentProps<"div"> & {
	id?: string;
	ref?: Ref<HTMLElement>;
	"data-active"?: string;
	"data-value"?: string;
	"data-disabled"?: boolean;
	"data-highlight"?: boolean;
	"data-slot"?: string;
};

type HighlightItemProps = ComponentProps<"div"> & {
	children: ReactNode;
	id?: string;
	value?: string;
	className?: string;
	transition?: Transition;
	activeClassName?: string;
	disabled?: boolean;
	exitDelay?: number;
	asChild?: boolean;
	forceUpdateBounds?: boolean;
};

function HighlightItem({
	ref,
	children,
	id,
	value,
	className,
	transition,
	disabled = false,
	activeClassName,
	exitDelay,
	asChild = false,
	forceUpdateBounds,
	...props
}: HighlightItemProps) {
	const itemId = useId();
	const {
		activeValue,
		setActiveValue,
		mode,
		setBounds,
		clearBounds,
		hover,
		enabled,
		className: contextClassName,
		transition: contextTransition,
		id: contextId,
		disabled: contextDisabled,
		exitDelay: contextExitDelay,
		forceUpdateBounds: contextForceUpdateBounds,
		setActiveClassName,
	} = useHighlight();

	const isValidChild = isValidElement<ExtendedChildProps>(children);
	const element = isValidChild ? children : null;
	const childValue =
		id ??
		value ??
		element?.props?.["data-value"] ??
		element?.props?.id ??
		itemId;
	const isActive = activeValue === childValue;
	const isDisabled = disabled === undefined ? contextDisabled : disabled;
	const itemTransition = transition ?? contextTransition;

	const localRef = useRef<HTMLDivElement>(null);
	useImperativeHandle<HTMLDivElement | null, HTMLDivElement | null>(
		ref,
		() => localRef.current
	);
	const childRef = element?.props.ref;
	const composedRef = useComposedRefs<HTMLElement>(childRef, localRef, ref);

	useEffect(() => {
		if (mode !== "parent") {
			return;
		}
		let rafId: number;
		let previousBounds: Bounds | null = null;
		const shouldUpdateBounds =
			forceUpdateBounds === true ||
			(contextForceUpdateBounds && forceUpdateBounds !== false);

		const updateBounds = () => {
			if (!localRef.current) {
				return;
			}

			const bounds = localRef.current.getBoundingClientRect();

			if (shouldUpdateBounds) {
				if (isSameBounds(previousBounds, bounds)) {
					rafId = requestAnimationFrame(updateBounds);
					return;
				}
				previousBounds = bounds;
				rafId = requestAnimationFrame(updateBounds);
			}

			setBounds(bounds);
		};

		if (isActive) {
			updateBounds();
			setActiveClassName(activeClassName ?? "");
		} else if (!activeValue) {
			clearBounds();
		}

		if (shouldUpdateBounds) {
			return () => cancelAnimationFrame(rafId);
		}
	}, [
		mode,
		isActive,
		activeValue,
		setBounds,
		clearBounds,
		activeClassName,
		setActiveClassName,
		forceUpdateBounds,
		contextForceUpdateBounds,
	]);

	if (!(isValidChild && element)) {
		return children;
	}

	const dataAttributes = {
		"data-active": isActive ? "true" : "false",
		"aria-selected": isActive,
		"data-disabled": isDisabled,
		"data-value": childValue,
		"data-highlight": true,
	};

	const commonHandlers = hover
		? {
				onMouseEnter: (e: MouseEvent<HTMLDivElement>) => {
					setActiveValue(childValue);
					element.props.onMouseEnter?.(e);
				},
				onMouseLeave: (e: MouseEvent<HTMLDivElement>) => {
					setActiveValue(null);
					element.props.onMouseLeave?.(e);
				},
			}
		: {
				onClick: (e: MouseEvent<HTMLDivElement>) => {
					setActiveValue(childValue);
					element.props.onClick?.(e);
				},
			};

	// The children-mode backdrop; parent mode draws one shared backdrop instead.
	const renderHighlight = () => (
		<AnimatePresence initial={false}>
			{isActive && !isDisabled && (
				<motion.div
					animate={{ opacity: 1 }}
					className={cn(
						"absolute inset-0 z-0 bg-muted",
						contextClassName,
						activeClassName
					)}
					data-slot="motion-highlight"
					exit={delayedFadeOut(
						itemTransition,
						exitDelay ?? contextExitDelay ?? 0
					)}
					initial={{ opacity: 0 }}
					layoutId={`transition-background-${contextId}`}
					transition={itemTransition}
					{...dataAttributes}
				/>
			)}
		</AnimatePresence>
	);

	if (asChild) {
		const { ref: _childRef, ...childProps } = element.props;

		if (mode === "children") {
			return createElement(
				element.type,
				{
					...childProps,
					key: childValue,
					ref: composedRef,
					className: cn("relative", element.props.className),
					...getNonOverridingDataAttributes(element, {
						...dataAttributes,
						"data-slot": "motion-highlight-item-container",
					}),
					...commonHandlers,
					...props,
				},
				<>
					{renderHighlight()}

					<div
						className={cn("relative z-1", className)}
						data-slot="motion-highlight-item"
						{...dataAttributes}
					>
						{children}
					</div>
				</>
			);
		}

		return createElement(element.type, {
			...childProps,
			ref: composedRef,
			...getNonOverridingDataAttributes(element, {
				...dataAttributes,
				"data-slot": "motion-highlight-item",
			}),
			...commonHandlers,
		});
	}

	return enabled ? (
		<div
			className={cn(mode === "children" && "relative", className)}
			data-slot="motion-highlight-item-container"
			key={childValue}
			ref={localRef}
			{...dataAttributes}
			{...props}
			{...commonHandlers}
		>
			{mode === "children" && renderHighlight()}

			{cloneElement(element, {
				className: cn("relative z-1", element.props.className),
				...getNonOverridingDataAttributes(element, {
					...dataAttributes,
					"data-slot": "motion-highlight-item",
				}),
			})}
		</div>
	) : (
		children
	);
}

export {
	Highlight,
	HighlightItem,
	type HighlightItemProps,
	type HighlightProps,
	useHighlight,
};
