"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { isNativeFunction } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import { z } from "zod";
import { usePortalContainer } from "./portal-container.tsx";

function HoverCard({ ...props }: PreviewCardPrimitive.Root.Props) {
	return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

/** Class callbacks receive the native PreviewCard state once; legacy citation
 * wrappers ignored callbacks through clsx, so opting into a role now honors them.
 */
function mergeCitationTriggerClasses(
	className: PreviewCardPrimitive.Trigger.Props["className"],
	recipe: string
): PreviewCardPrimitive.Trigger.Props["className"] {
	if (isNativeFunction(className)) {
		return (state) => cn(recipe, className(state));
	}
	return cn(recipe, className);
}

function mergeChatNavigationTriggerClasses(
	className: PreviewCardPrimitive.Trigger.Props["className"]
): PreviewCardPrimitive.Trigger.Props["className"] {
	const recipe =
		"group/toc-item relative flex h-6 cursor-pointer items-center gap-2 py-1 text-left";
	if (isNativeFunction(className)) {
		return (state) => {
			const custom = className(state);
			return custom ? `${recipe} ${custom}` : recipe;
		};
	}
	return className ? `${recipe} ${className}` : recipe;
}

function HoverCardTrigger({
	appearance,
	interactive,
	contextTone,
	...props
}: PreviewCardPrimitive.Trigger.Props & {
	appearance?:
		| "statistics"
		| "citation-pill"
		| "citation-mark"
		| "context-meter"
		| "chat-navigation";
	interactive?: boolean;
	contextTone?: "warning" | "destructive";
}) {
	let triggerProps = props;
	if (appearance === "statistics") {
		const classes = z.string().safeParse(props.className);
		triggerProps = classes.success
			? {
					...props,
					className: cn(
						"cursor-default gap-1.5 text-muted-foreground",
						classes.data
					),
				}
			: mergeProps(
					{ className: "cursor-default text-muted-foreground gap-1.5" },
					props
				);
	} else if (appearance === "chat-navigation") {
		triggerProps = {
			...props,
			className: mergeChatNavigationTriggerClasses(props.className),
		};
	} else if (
		appearance === "citation-pill" ||
		appearance === "citation-mark" ||
		appearance === "context-meter"
	) {
		const recipe =
			appearance === "context-meter"
				? cn(
						"type-caption flex h-7 w-fit shrink-0 select-none items-center gap-1 rounded-md px-1 text-muted-foreground tabular-nums",
						interactive
							? "cursor-pointer hover:bg-accent hover:text-foreground"
							: "cursor-default",
						contextTone === "warning" && "text-status-warning",
						contextTone === "destructive" && "text-status-destructive"
					)
				: appearance === "citation-pill"
					? "type-caption inline-flex cursor-default items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 align-middle font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
					: "type-micro inline-flex h-3 min-w-3 cursor-pointer items-center justify-center rounded bg-muted px-0.5 align-[5.5px] font-medium text-muted-foreground leading-none no-underline transition-colors hover:bg-muted/80 hover:text-foreground";
		triggerProps = {
			...props,
			className: mergeCitationTriggerClasses(props.className, recipe),
		};
	}
	return (
		<PreviewCardPrimitive.Trigger
			data-slot="hover-card-trigger"
			{...triggerProps}
		/>
	);
}

function HoverCardContent({
	anchor,
	appearance,
	className,
	typography,
	spacing,
	side = "bottom",
	sideOffset = 4,
	align = "center",
	alignOffset = 4,
	...props
}: PreviewCardPrimitive.Popup.Props & {
	typography?: "compact";
	spacing?: "rail" | "conversation-preview";
	appearance?: "citation-popup" | "composer-preview" | "sidebar-preview";
} & Pick<
		PreviewCardPrimitive.Positioner.Props,
		"align" | "alignOffset" | "anchor" | "side" | "sideOffset"
	>) {
	const direction = useDirection();
	return (
		<PreviewCardPrimitive.Portal
			container={usePortalContainer()}
			data-slot="hover-card-portal"
		>
			<PreviewCardPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				anchor={anchor}
				className="isolate z-50"
				side={side}
				sideOffset={sideOffset}
			>
				<PreviewCardPrimitive.Popup
					className={cn(
						"data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 relative z-50 w-72 origin-(--transform-origin) rounded-3xl border border-border/50 bg-popover/70 p-4 text-popover-foreground text-sm outline-hidden backdrop-blur-2xl backdrop-saturate-150 duration-(--dropdown-open-dur) ease-(--dropdown-ease) before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:rounded-[inherit] data-closed:animate-out data-open:animate-in data-closed:duration-(--dropdown-close-dur)",
						typography === "compact" && "text-xs",
						spacing === "rail" && "p-3",
						appearance === "citation-popup" &&
							"w-80 max-w-[min(90vw,20rem)] p-0 text-sm",
						appearance === "composer-preview" &&
							"rounded-2xl border-border/70 bg-popover/95 p-2 shadow-xl backdrop-blur-xl",
						appearance === "sidebar-preview" &&
							"w-80 max-w-[min(20rem,calc(100vw-2rem))] p-4 text-sm",
						spacing === "conversation-preview" && "p-1",
						className
					)}
					data-slot="hover-card-content"
					{...props}
					dir={direction}
				/>
			</PreviewCardPrimitive.Positioner>
		</PreviewCardPrimitive.Portal>
	);
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
