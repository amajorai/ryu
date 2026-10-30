"use client";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Children,
	createContext,
	isValidElement,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
} from "react";

const useSafeLayoutEffect =
	globalThis.window === undefined ? useEffect : useLayoutEffect;

type TabsValue = TabsPrimitive.Tab.Props["value"];
type TabsChangeDetails = TabsPrimitive.Root.ChangeEventDetails;

interface TabsContextValue {
	activeValue: TabsValue | undefined;
	orientation: "horizontal" | "vertical";
	selectValue: (value: TabsValue) => boolean;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
	const context = useContext(TabsContext);
	if (!context) {
		throw new Error("TabsList must be used inside Tabs");
	}
	return context;
}

function createProgrammaticChangeDetails(): TabsChangeDetails {
	let canceled = false;
	let propagationAllowed = false;
	return {
		reason: "none",
		event: new Event("ryu-tabs-selection"),
		cancel: () => {
			canceled = true;
		},
		allowPropagation: () => {
			propagationAllowed = true;
		},
		get isCanceled() {
			return canceled;
		},
		get isPropagationAllowed() {
			return propagationAllowed;
		},
		trigger: undefined,
		activationDirection: "none",
	};
}

function findFirstEnabledTabValue(children: ReactNode): TabsValue | undefined {
	for (const child of Children.toArray(children)) {
		if (!isValidElement<TabsPrimitive.Tab.Props>(child)) {
			continue;
		}
		const props = child.props;
		if ("value" in props && props.value !== undefined && !props.disabled) {
			return props.value;
		}
		const nestedValue = findFirstEnabledTabValue(props.children);
		if (nestedValue !== undefined) {
			return nestedValue;
		}
	}
	return undefined;
}

type TabsProps = TabsPrimitive.Root.Props & {
	spacing?: "flush" | "comfortable" | "relaxed" | "generous";
	inset?: "agent-activity" | "store-sections" | "library-sections";
};

function Tabs({
	className,
	spacing,
	inset,
	orientation = "horizontal",
	value,
	defaultValue,
	onValueChange,
	children,
	...props
}: TabsProps) {
	const initialValue =
		defaultValue === undefined
			? findFirstEnabledTabValue(children)
			: defaultValue;
	const [uncontrolledValue, setUncontrolledValue] = useState<
		TabsValue | undefined
	>(initialValue);
	const resolvedValue = value === undefined ? uncontrolledValue : value;

	const handleValueChange = useCallback(
		(nextValue: TabsValue, eventDetails: TabsChangeDetails) => {
			onValueChange?.(nextValue, eventDetails);
			if (!eventDetails.isCanceled) {
				setUncontrolledValue(nextValue);
			}
		},
		[onValueChange]
	);
	const selectValue = useCallback(
		(nextValue: TabsValue) => {
			const eventDetails = createProgrammaticChangeDetails();
			handleValueChange(nextValue, eventDetails);
			return !eventDetails.isCanceled;
		},
		[handleValueChange]
	);
	const contextValue = useMemo(
		() => ({
			activeValue: resolvedValue,
			orientation,
			selectValue,
		}),
		[orientation, resolvedValue, selectValue]
	);

	return (
		<TabsContext.Provider value={contextValue}>
			<TabsPrimitive.Root
				className={cn(
					"group/tabs flex gap-2 has-[[data-slot=tabs-list-sticky]]:flex-col-reverse data-horizontal:flex-col md:has-[[data-slot=tabs-list-sticky]]:flex-col",
					spacing === "flush" && "gap-0",
					spacing === "comfortable" && "gap-4",
					spacing === "relaxed" && "gap-3",
					spacing === "generous" && "gap-8",
					inset === "agent-activity" && "p-3",
					inset === "store-sections" && "pt-2 pb-1",
					inset === "library-sections" && "pt-2",
					className
				)}
				data-orientation={orientation}
				data-slot="tabs"
				defaultValue={resolvedValue === undefined ? defaultValue : undefined}
				onValueChange={handleValueChange}
				orientation={orientation}
				value={resolvedValue}
				{...props}
			>
				{children}
			</TabsPrimitive.Root>
		</TabsContext.Provider>
	);
}

export { Tabs, type TabsValue, useSafeLayoutEffect, useTabsContext };
