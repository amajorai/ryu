"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { composeRefs } from "@ryu/ui/lib/compose-refs.ts";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
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
import { usePortalContainer } from "./portal-container.tsx";

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

function mergeMessageReadTriggerClasses(
	className: PopoverPrimitive.Trigger.Props["className"]
): PopoverPrimitive.Trigger.Props["className"] {
	const recipe =
		"inline-flex items-center gap-1 rounded-full outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";
	if (isNativeFunction(className)) {
		return (state) => {
			const custom = className(state);
			return custom ? `${recipe} ${custom}` : recipe;
		};
	}
	return className ? `${recipe} ${className}` : recipe;
}

function mergeNativeTriggerPurposeClasses(
	className: PopoverPrimitive.Trigger.Props["className"],
	recipe: string
): PopoverPrimitive.Trigger.Props["className"] {
	if (isNativeFunction(className)) {
		return (state) => cn(recipe, className(state));
	}
	return cn(recipe, className);
}

function PopoverTrigger({
	className,
	variant = "default",
	size = "default",
	...props
}: PopoverPrimitive.Trigger.Props & {
	variant?:
		| "default"
		| "muted"
		| "date-range"
		| "marketplace-add"
		| "message-read-receipt"
		| "sessions"
		| "system-status"
		| "startup-wallpaper";
	size?: "default" | "compact";
}) {
	const nativePurposeRecipe =
		variant === "sessions"
			? "flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
			: variant === "system-status"
				? "flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-muted-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
				: variant === "startup-wallpaper"
					? "flex h-9 items-center gap-2 rounded-full px-3.5 font-medium text-white text-xs border border-white/25 bg-white/[0.12] shadow-[inset_0_1px_0_rgba(255,255,255,0.55),inset_0_-1px_1px_rgba(255,255,255,0.12),inset_0_0_12px_rgba(255,255,255,0.08),0_10px_30px_rgba(0,0,0,0.25)] backdrop-blur-2xl backdrop-saturate-[1.8] transition-[background-color,transform,box-shadow] hover:bg-white/[0.2] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
					: undefined;
	const localizedChildren = useLocalizedText(props.children, { literal: true });
	const localizedAriaLabel = useLocalizedString(props["aria-label"]);
	const localizedTitle = useLocalizedString(props.title);
	return (
		<PopoverPrimitive.Trigger
			className={
				nativePurposeRecipe === undefined
					? variant === "message-read-receipt"
						? mergeMessageReadTriggerClasses(className)
						: variant === "default" && size === "default"
							? className
							: cn(
									variant === "muted" &&
										"rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
									size === "compact" && "px-2 py-1 text-xs",
									variant === "marketplace-add" &&
										"gap-1.5 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground",
									variant === "date-range" &&
										"inline-flex h-9 items-center gap-2 rounded-3xl border border-input bg-input/50 px-3 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring",
									className
								)
					: mergeNativeTriggerPurposeClasses(className, nativePurposeRecipe)
			}
			data-slot="popover-trigger"
			{...props}
			aria-label={localizedAriaLabel}
			title={localizedTitle}
		>
			{localizedChildren}
		</PopoverPrimitive.Trigger>
	);
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
	appearance,
	spacing = "default",
	corners = "default",
	positionerClassName,
	align = "center",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	...props
}: PopoverPrimitive.Popup.Props &
	Pick<
		PopoverPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	> & {
		positionerClassName?: string;
		appearance?: "message-read-list" | "composer-menu" | "agent-recipient-list";
		spacing?:
			| "default"
			| "compact"
			| "rail"
			| "flush"
			| "inset"
			| "menu"
			| "dense-menu"
			| "small-inset"
			| "choice-grid"
			| "form";
		corners?: "default" | "rounded";
	}) {
	const ctx = useContext(PopoverAnchorContext);
	const direction = useDirection();
	const localizedChildren = useLocalizedText(props.children, { literal: true });
	return (
		<PopoverPrimitive.Portal container={usePortalContainer()}>
			<PopoverPrimitive.Backdrop
				className="ryu-popup-overlay"
				data-slot="popover-overlay"
			/>
			<PopoverPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={ctx?.hasAnchor ? ctx.anchorRef : undefined}
				className={cn("isolate z-50", positionerClassName)}
				side={side}
				sideOffset={sideOffset}
			>
				<PopoverPrimitive.Popup
					className={cn(
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 corner-squircle before:corner-squircle relative z-50 flex w-72 origin-(--transform-origin) flex-col gap-4 rounded-3xl border border-border/50 bg-popover/70 p-4 text-popover-foreground text-sm outline-hidden backdrop-blur-2xl backdrop-saturate-150 duration-(--dropdown-open-dur) ease-(--dropdown-ease) before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-closed:animate-out data-open:animate-in data-closed:duration-(--dropdown-close-dur)",
						spacing === "compact" && "gap-2 p-2",
						spacing === "rail" && "p-3",
						spacing === "flush" && "p-0",
						spacing === "inset" && "p-2",
						spacing === "menu" && "gap-0 p-2",
						spacing === "dense-menu" && "gap-0 p-1.5",
						spacing === "small-inset" && "p-1",
						spacing === "choice-grid" && "gap-1 p-2",
						spacing === "form" && "gap-3",
						corners === "rounded" && "rounded-2xl",
						appearance === "message-read-list" && "gap-3 bg-popover p-3",
						appearance === "agent-recipient-list" &&
							"w-72 gap-1 bg-popover p-1.5",
						appearance === "composer-menu" &&
							"border-border/70 bg-popover/95 shadow-xl",
						className
					)}
					data-slot="popover-content"
					{...props}
					dir={direction}
				>
					{localizedChildren}
				</PopoverPrimitive.Popup>
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

function PopoverTitle({
	className,
	children,
	...props
}: PopoverPrimitive.Title.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<PopoverPrimitive.Title
			className={cn("font-medium text-base", className)}
			data-slot="popover-title"
			{...props}
		>
			{localizedChildren}
		</PopoverPrimitive.Title>
	);
}

function PopoverDescription({
	className,
	children,
	...props
}: PopoverPrimitive.Description.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<PopoverPrimitive.Description
			className={cn("text-muted-foreground", className)}
			data-slot="popover-description"
			{...props}
		>
			{localizedChildren}
		</PopoverPrimitive.Description>
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
