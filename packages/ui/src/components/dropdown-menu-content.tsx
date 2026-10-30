"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useDirection } from "@ryu/ui/components/direction.tsx";
import { renderDropdownPopup } from "@ryu/ui/components/dropdown-menu-motion.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef } from "react";
import { DrawerContent, DrawerHeader, DrawerTitle } from "./drawer.tsx";
import { useDropdownMenuContext } from "./dropdown-menu-context.ts";
import { usePortalContainer } from "./portal-container.tsx";

function DropdownMenuContent({
	align = "start",
	alignOffset = 0,
	side = "bottom",
	sideOffset = 4,
	className,
	drawerLabel = "Menu",
	withBackdrop = true,
	...props
}: MenuPrimitive.Popup.Props &
	Pick<
		MenuPrimitive.Positioner.Props,
		"align" | "alignOffset" | "side" | "sideOffset"
	> & {
		/** Accessible title shown in the mobile drawer. */
		drawerLabel?: string;
		/** Render the shared full-window backdrop for a top-level menu. */
		withBackdrop?: boolean;
	}) {
	const direction = useDirection();
	const portalContainer = usePortalContainer();
	const { goBack, isMobile, open, submenuPath, submenus } =
		useDropdownMenuContext();
	const popupRef = useRef<HTMLDivElement>(null);
	const previousPathRef = useRef(submenuPath);
	const activeSubmenuId = submenuPath.at(-1);
	const activeSubmenu = activeSubmenuId
		? submenus.get(activeSubmenuId)
		: undefined;
	useEffect(() => {
		const pathChanged = previousPathRef.current !== submenuPath;
		previousPathRef.current = submenuPath;
		if (!(isMobile && open && pathChanged)) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			popupRef.current
				?.querySelector<HTMLElement>(
					"[data-slot$='-item']:not([data-disabled='true']), [role='menuitem']:not([aria-disabled='true'])"
				)
				?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [isMobile, open, submenuPath]);
	if (isMobile) {
		return (
			<MenuPrimitive.Portal container={portalContainer}>
				<DrawerContent
					className={cn(
						"!max-h-[90dvh] !w-full !max-w-none !overflow-hidden !rounded-b-none !p-3"
					)}
					data-drawer-mode="true"
				>
					<DrawerHeader className="sr-only">
						<DrawerTitle className="text-left text-base">
							{activeSubmenu?.title ?? drawerLabel}
						</DrawerTitle>
					</DrawerHeader>
					<MenuPrimitive.Positioner
						align="center"
						className="!relative !inset-auto !top-auto !right-auto !bottom-auto !left-auto !z-auto !h-auto !w-full !min-w-0 !max-w-none !transform-none outline-none"
						side="bottom"
						sideOffset={0}
					>
						<MenuPrimitive.Popup
							className={cn(
								className,
								"!max-h-[calc(90dvh-6rem)] !w-full !min-w-0 !max-w-none !overflow-y-auto !overflow-x-hidden !rounded-none !border-0 !bg-transparent !p-0 !shadow-none !backdrop-blur-none text-popover-foreground outline-none **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!"
							)}
							data-drawer-mode="true"
							data-drawer-submenu={activeSubmenuId}
							data-slot="dropdown-menu-content"
							dir={direction}
							ref={popupRef}
							{...props}
						>
							{activeSubmenu && (
								<div className="flex min-h-11 items-center gap-2 px-2 py-1 text-left">
									<MenuPrimitive.Item
										aria-label="Back to previous menu"
										className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring"
										closeOnClick={false}
										data-slot="dropdown-menu-back"
										onClick={goBack}
									>
										<HugeiconsIcon
											aria-hidden="true"
											icon={ArrowLeft01Icon}
											strokeWidth={2}
										/>
									</MenuPrimitive.Item>
									<span
										className="font-medium text-base"
										data-slot="dropdown-menu-submenu-title"
									>
										{activeSubmenu.title}
									</span>
								</div>
							)}
							{activeSubmenu
								? activeSubmenu.content
								: activeSubmenuId
									? null
									: props.children}
						</MenuPrimitive.Popup>
					</MenuPrimitive.Positioner>
				</DrawerContent>
			</MenuPrimitive.Portal>
		);
	}
	return (
		<MenuPrimitive.Portal container={portalContainer}>
			{withBackdrop && (
				<MenuPrimitive.Backdrop
					className="ryu-popup-overlay"
					data-slot="dropdown-menu-overlay"
				/>
			)}
			<MenuPrimitive.Positioner
				align={align}
				alignOffset={alignOffset}
				className="isolate z-50 outline-none"
				side={side}
				sideOffset={sideOffset}
			>
				<MenuPrimitive.Popup
					className={cn(
						"relative z-50 max-h-[var(--available-height)] w-[var(--anchor-width)] min-w-48 max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-popover) outline-none data-closed:overflow-hidden **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10! **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
						className
					)}
					data-slot="dropdown-menu-content"
					{...props}
					dir={direction}
					render={renderDropdownPopup}
				/>
			</MenuPrimitive.Positioner>
		</MenuPrimitive.Portal>
	);
}

export { DropdownMenuContent };
