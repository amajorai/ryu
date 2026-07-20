"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	type ComponentProps,
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

// The vendored Plate components use a Radix-style `PopoverAnchor` to position a
// popover against an arbitrary element (incl. a virtual ref). Base UI has no
// `Anchor` part, but its `Positioner` accepts an `anchor` prop — so we bridge
// the two through context: `PopoverAnchor` registers the anchor, and
// `PopoverContent` forwards it to the Positioner.
type AnchorValue = Element | { current: Element | null } | null;

const PopoverAnchorContext = createContext<{
	anchor: AnchorValue;
	setAnchor: (anchor: AnchorValue) => void;
} | null>(null);

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
	const [anchor, setAnchor] = useState<AnchorValue>(null);
	const value = useMemo(() => ({ anchor, setAnchor }), [anchor]);
	return (
		<PopoverAnchorContext.Provider value={value}>
			<PopoverPrimitive.Root data-slot="popover" {...props} />
		</PopoverAnchorContext.Provider>
	);
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
	return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

// Radix-compatible anchor shim. `virtualRef` (a `{ current: Element }`) registers
// a virtual anchor and renders nothing; otherwise the element it wraps becomes
// the anchor and is rendered in place.
function PopoverAnchor({
	virtualRef,
	className,
	children,
	...props
}: {
	virtualRef?: { current: Element | null };
	className?: string;
	children?: ReactNode;
} & ComponentProps<"span">) {
	const ctx = useContext(PopoverAnchorContext);
	const ref = useRef<HTMLSpanElement | null>(null);

	useEffect(() => {
		if (!ctx) {
			return;
		}
		if (virtualRef) {
			ctx.setAnchor(virtualRef);
		} else if (ref.current) {
			ctx.setAnchor(ref.current);
		}
	}, [ctx, virtualRef]);

	if (virtualRef) {
		return null;
	}

	return (
		<span className={className} data-slot="popover-anchor" ref={ref} {...props}>
			{children}
		</span>
	);
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
				anchor={ctx?.anchor ?? undefined}
				className="isolate z-50"
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 rounded-3xl bg-popover p-4 text-popover-foreground text-sm shadow-lg outline-hidden duration-100 data-closed:animate-out data-open:animate-in",
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
