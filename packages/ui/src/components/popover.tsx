"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { composeRefs } from "@ryu/ui/lib/compose-refs.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Children,
	type ComponentProps,
	cloneElement,
	createContext,
	type ReactElement,
	type Ref,
	type RefObject,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

// Base UI's Popover has no standalone `Anchor` part (the Positioner anchors to
// the Trigger by default, or to an element passed via its `anchor` prop). To
// support a Radix-style `<PopoverAnchor asChild>` (anchor the popup to an
// arbitrary element while opening is controlled elsewhere — used by the data
// grid's editable cells), we capture the anchor element in context and forward
// it to the Positioner. This is fully opt-in: when no `PopoverAnchor` is
// rendered, `hasAnchor` stays false and `PopoverContent` behaves exactly as
// before (anchored to the Trigger), so existing consumers are unaffected.
interface PopoverAnchorContextValue {
	anchorRef: RefObject<HTMLElement | null>;
	hasAnchor: boolean;
	setHasAnchor: (value: boolean) => void;
}

const PopoverAnchorContext = createContext<PopoverAnchorContextValue | null>(
	null
);

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
	const anchorRef = useRef<HTMLElement | null>(null);
	const [hasAnchor, setHasAnchor] = useState(false);
	const value = useMemo<PopoverAnchorContextValue>(
		() => ({ anchorRef, hasAnchor, setHasAnchor }),
		[hasAnchor]
	);
	return (
		<PopoverAnchorContext.Provider value={value}>
			<PopoverPrimitive.Root data-slot="popover" {...props} />
		</PopoverAnchorContext.Provider>
	);
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({
	children,
}: {
	/** Accepted for Radix API parity; the single child is always cloned. */
	asChild?: boolean;
	children: ReactElement<{ ref?: Ref<HTMLElement> }>;
}) {
	const ctx = useContext(PopoverAnchorContext);
	const setHasAnchor = ctx?.setHasAnchor;
	useEffect(() => {
		setHasAnchor?.(true);
		return () => setHasAnchor?.(false);
	}, [setHasAnchor]);
	const child = Children.only(children);
	return cloneElement(child, {
		ref: composeRefs(ctx?.anchorRef ?? null, child.props.ref),
	});
}

function PopoverContent({
	className,
	align = "center",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	>) {
	const ctx = useContext(PopoverAnchorContext);
	return (
		<PopoverPrimitive.Portal>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={ctx?.hasAnchor ? ctx.anchorRef : undefined}
				className="isolate z-50"
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 relative z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 rounded-3xl border border-border/50 bg-popover/70 p-4 text-popover-foreground text-sm outline-hidden backdrop-blur-2xl backdrop-saturate-150 duration-100 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-closed:animate-out data-open:animate-in",
						className
					)}
					data-slot="popover-content"
					{...props}
				/>
			</PopoverPrimitive.Positioner>
		</PopoverPrimitive.Portal>
	);
}

function PopoverHeader({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn("flex flex-col gap-1 text-sm", className)}
			data-slot="popover-header"
			{...props}
		/>
	);
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
	return (
		<PopoverPrimitive.Title
			className={cn("font-medium text-base", className)}
			data-slot="popover-title"
			{...props}
		/>
	);
}

function PopoverDescription({
	className,
	...props
}: PopoverPrimitive.Description.Props) {
	return (
		<PopoverPrimitive.Description
			className={cn("text-muted-foreground", className)}
			data-slot="popover-description"
			{...props}
		/>
	);
}

export {
	Popover,
	PopoverAnchor,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
};
