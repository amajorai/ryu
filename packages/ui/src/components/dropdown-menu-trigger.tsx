"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { z } from "zod";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";

const nativeTriggerCallbackSchema = z.custom<
	Exclude<MenuPrimitive.Trigger.Props["className"], string | undefined>
>((value) => z.function().safeParse(value).success);
function mergeNavigationTriggerClasses(
	className: MenuPrimitive.Trigger.Props["className"],
	navigationClasses: string
): MenuPrimitive.Trigger.Props["className"] {
	const admitted = nativeTriggerCallbackSchema.safeParse(className);
	if (admitted.success) {
		const callback = admitted.data;
		return (state) => cn(navigationClasses, callback(state));
	}
	return cn(navigationClasses, z.string().optional().parse(className));
}

function DropdownMenuTrigger({
	children,
	className,
	variant = "default",
	motion = "none",
	reveal,
	activeHighlight = false,
	navigationState = "inactive",
	navigationContrast = "normal",
	selected = false,
	...props
}: MenuPrimitive.Trigger.Props & {
	variant?:
		| "default"
		| "muted"
		| "glass"
		| "navigation"
		| "panel-picker"
		| "panel-action"
		| "breadcrumbs"
		| "chat-picker"
		| "conversation-action"
		| "account-picker"
		| "queue-message-options"
		| "queue-options"
		| "account-row"
		| "sidebar-options"
		| "rounded-control"
		| "dialog-control"
		| "blurred-control"
		| "toolkit-picker"
		| "conversation-options"
		| "organization-picker";
	selected?: boolean;
	navigationState?: "active" | "inactive";
	navigationContrast?: "normal" | "inverse";
	motion?: "none" | "color" | "opacity";
	reveal?: "section" | "subsection" | "thread";
	activeHighlight?: boolean;
}) {
	const desktopTriggerClasses =
		variant === "account-row"
			? "rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/50"
			: variant === "sidebar-options"
				? "inline-flex h-6 w-6 items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100"
				: variant === "rounded-control"
					? "rounded-lg border px-3 py-2 text-sm"
					: variant === "dialog-control"
						? "inline-flex h-10 w-fit items-center justify-center rounded-full border px-4 font-medium text-sm transition-colors hover:bg-accent"
						: variant === "blurred-control"
							? "rounded-xl border border-border/70 bg-background/70 px-4 py-2 text-sm"
							: variant === "toolkit-picker"
								? "flex h-8 items-center rounded-lg border px-3 text-xs"
								: variant === "conversation-options"
									? "hidden h-5 w-5 shrink-0 items-center justify-center rounded outline-none hover:bg-accent focus-visible:inline-flex focus-visible:ring-2 focus-visible:ring-ring aria-expanded:inline-flex group-focus-within/row:inline-flex group-hover/row:inline-flex data-[popup-open]:inline-flex"
									: variant === "organization-picker"
										? "flex w-full items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-60"
										: undefined;
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<MenuPrimitive.Trigger
			className={
				desktopTriggerClasses === undefined
					? variant === "queue-message-options"
						? mergeNavigationTriggerClasses(
								className,
								"size-5 rounded-sm text-base text-muted-foreground/70 hover:bg-muted hover:text-foreground"
							)
						: variant === "queue-options"
							? mergeNavigationTriggerClasses(
									className,
									"size-6 rounded-sm text-lg text-muted-foreground hover:bg-muted hover:text-foreground"
								)
							: variant === "chat-picker"
								? mergeNavigationTriggerClasses(
										className,
										"inline-flex h-10 w-full items-center justify-center gap-2 whitespace-nowrap rounded-md border border-input bg-background px-4 py-2 font-medium text-sm ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
									)
								: variant === "conversation-action"
									? mergeNavigationTriggerClasses(
											className,
											"inline-flex h-8 w-8 items-center justify-center rounded-md p-0 font-medium text-sm opacity-0 ring-offset-background transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
										)
									: variant === "account-picker"
										? mergeNavigationTriggerClasses(
												className,
												"flex w-full items-center gap-3 rounded-lg bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
											)
										: variant === "navigation"
											? mergeNavigationTriggerClasses(
													className,
													cn(
														"inline-flex shrink-0 items-center justify-center rounded-full px-3 py-1 font-medium text-sm transition-[color,background-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
														navigationState === "active"
															? navigationContrast === "inverse"
																? "bg-background text-foreground hover:bg-background/80"
																: "bg-foreground text-background hover:bg-foreground/80"
															: navigationContrast === "inverse"
																? "text-background/65 hover:bg-background/10 hover:text-background"
																: "text-foreground/60 hover:bg-foreground/5 hover:text-foreground",
														"gap-1.5"
													)
												)
											: variant === "default" &&
													motion === "none" &&
													!reveal &&
													!activeHighlight
												? className
												: cn(
														variant === "muted" &&
															"rounded text-muted-foreground hover:bg-accent hover:text-foreground",
														variant === "glass" &&
															"rounded-lg border border-glass-content/15 bg-glass-content/10 px-3 py-2 font-medium text-sm hover:bg-glass-content/15",
														motion === "color" && "transition-colors",
														motion === "opacity" && "transition-opacity",
														reveal === "section" &&
															"opacity-0 focus-visible:opacity-100 group-hover/section:opacity-100 data-[popup-open]:opacity-100",
														reveal === "subsection" &&
															"opacity-0 focus-visible:opacity-100 group-hover/subsection:opacity-100 data-[popup-open]:opacity-100",
														reveal === "thread" &&
															"opacity-0 group-hover/thread:opacity-100",
														activeHighlight && "data-[popup-open]:bg-accent",
														variant === "panel-picker" &&
															"px-0.5 text-muted-foreground transition-colors hover:text-foreground",
														variant === "panel-action" &&
															"rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
														variant === "breadcrumbs" &&
															"gap-1.5 rounded-full px-2.5 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted/50 hover:text-foreground",
														className
													)
					: mergeNavigationTriggerClasses(
							className,
							cn(desktopTriggerClasses, selected && "bg-foreground/10")
						)
			}
			data-cuelume-toggle=""
			data-slot="dropdown-menu-trigger"
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
		</MenuPrimitive.Trigger>
	);
}

export { DropdownMenuTrigger };
