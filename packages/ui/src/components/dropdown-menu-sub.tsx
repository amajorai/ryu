"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ComponentProps, useContext, useEffect, useId } from "react";
import { DropdownMenuContent } from "./dropdown-menu-content.tsx";
import {
	DropdownMenuSubContext,
	useDropdownMenuContext,
} from "./dropdown-menu-context.ts";
import {
	activateMobileSubmenuTrigger,
	mobileSubmenuItemProps,
	renderMobileSubmenuChildren,
} from "./dropdown-menu-mobile.ts";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";

function DropdownMenuSub({
	children,
	defaultOpen = false,
	open: controlledOpen,
	...props
}: MenuPrimitive.SubmenuRoot.Props) {
	const { isMobile, setSubmenuPath } = useDropdownMenuContext();
	const submenuId = useId();
	useEffect(() => {
		if (!isMobile || (controlledOpen === undefined && !defaultOpen)) {
			return;
		}
		setSubmenuPath((current) => {
			const currentIndex = current.indexOf(submenuId);
			if (controlledOpen ?? defaultOpen) {
				if (currentIndex === current.length - 1) {
					return current;
				}
				const nextIndex = currentIndex < 0 ? current.length : currentIndex;
				return [...current.slice(0, nextIndex), submenuId];
			}
			return currentIndex < 0 ? current : current.slice(0, currentIndex);
		});
	}, [controlledOpen, defaultOpen, isMobile, setSubmenuPath, submenuId]);
	if (isMobile) {
		const submenuChildren = renderMobileSubmenuChildren(children);
		return (
			<DropdownMenuSubContext.Provider value={submenuId}>
				{submenuChildren}
			</DropdownMenuSubContext.Provider>
		);
	}
	return (
		<DropdownMenuSubContext.Provider value={submenuId}>
			<MenuPrimitive.SubmenuRoot
				data-slot="dropdown-menu-sub"
				{...props}
				defaultOpen={defaultOpen}
				open={controlledOpen}
			>
				{children}
			</MenuPrimitive.SubmenuRoot>
		</DropdownMenuSubContext.Provider>
	);
}

function DropdownMenuSubTrigger({
	className,
	spacing = "default",
	density = "default",
	purpose = "default",
	active = false,
	tone = "default",
	inset,
	children,
	onClick,
	render,
	style,
	delay,
	closeDelay,
	openOnHover,
	...props
}: MenuPrimitive.SubmenuTrigger.Props & {
	inset?: boolean;
	purpose?: "default" | "layer-selection";
	active?: boolean;
	spacing?: "default" | "comfortable" | "spacious";
	density?: "default" | "compact";
	tone?: "default" | "muted" | "foreground";
}) {
	const { isMobile, registerSubmenuTitle, setSubmenuPath, submenuPath } =
		useDropdownMenuContext();
	const submenuId = useContext(DropdownMenuSubContext);
	useEffect(() => {
		if (isMobile && submenuId) {
			registerSubmenuTitle(submenuId, children);
		}
	}, [children, isMobile, registerSubmenuTitle, submenuId]);
	const localizedChildren = useLocalizedText(children, { literal: true });
	if (isMobile) {
		if (!submenuId) {
			throw new Error("Submenu trigger must be inside DropdownMenuSub.");
		}
		const mobileProps = mobileSubmenuItemProps(
			{ render, style },
			submenuPath.at(-1) === submenuId
		);
		return (
			<MenuPrimitive.Item
				aria-expanded={submenuPath.at(-1) === submenuId}
				aria-haspopup="menu"
				className={cn(
					"flex min-h-[44px] cursor-default select-none items-center gap-1.5 rounded-lg px-4 py-2.5 font-medium text-base outline-hidden focus:bg-accent focus:text-accent-foreground data-inset:ps-9.5 [&_svg:not([class*='size-'])]:size-5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
					spacing === "comfortable" && "gap-2",
					spacing === "spacious" && "gap-2.5",
					density === "compact" && "text-xs",
					tone === "muted" && "text-muted-foreground",
					tone === "foreground" && "text-foreground",
					purpose === "layer-selection" && "gap-2 py-1 font-normal text-xs",
					active && "bg-foreground/10",
					className
				)}
				closeOnClick={false}
				data-inset={inset}
				data-slot="dropdown-menu-sub-trigger"
				onClick={(event) => {
					if (activateMobileSubmenuTrigger(event, onClick)) {
						setSubmenuPath((current) => [...current, submenuId]);
					}
				}}
				{...mobileProps}
				{...props}
			>
				<FadeOverflowTextChildren className="flex-1">
					{localizedChildren}
				</FadeOverflowTextChildren>
				<HugeiconsIcon
					className="ms-auto rtl:rotate-180"
					icon={ArrowRight01Icon}
					strokeWidth={2}
				/>
			</MenuPrimitive.Item>
		);
	}
	return (
		<MenuPrimitive.SubmenuTrigger
			className={cn(
				"flex cursor-default select-none items-center gap-1.5 rounded-lg px-2 py-1 font-medium text-sm outline-hidden focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-open:bg-accent data-popup-open:bg-accent data-inset:ps-9.5 data-open:text-accent-foreground data-popup-open:text-accent-foreground [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				isMobile &&
					"min-h-[44px] px-4 py-2.5 text-base [&_svg:not([class*='size-'])]:size-5",
				spacing === "comfortable" && "gap-2",
				spacing === "spacious" && "gap-2.5",
				density === "compact" && "text-xs",
				tone === "muted" && "text-muted-foreground",
				tone === "foreground" && "text-foreground",
				purpose === "layer-selection" && "gap-2 py-1 font-normal text-xs",
				active && "bg-foreground/10",
				className
			)}
			closeDelay={closeDelay}
			data-inset={inset}
			data-slot="dropdown-menu-sub-trigger"
			delay={delay}
			onClick={onClick}
			openOnHover={openOnHover}
			style={style}
			{...props}
		>
			<FadeOverflowTextChildren className="flex-1">
				{localizedChildren}
			</FadeOverflowTextChildren>
			<HugeiconsIcon
				className="ms-auto rtl:rotate-180"
				icon={ArrowRight01Icon}
				strokeWidth={2}
			/>
		</MenuPrimitive.SubmenuTrigger>
	);
}

function DropdownMenuSubContent({
	children,
	align = "start",
	alignOffset = -3,
	side = "inline-end",
	sideOffset = 0,
	className,
	...props
}: ComponentProps<typeof DropdownMenuContent>) {
	const { isMobile, registerSubmenuContent } = useDropdownMenuContext();
	const submenuId = useContext(DropdownMenuSubContext);
	useEffect(() => {
		if (isMobile && submenuId) {
			registerSubmenuContent(submenuId, children);
		}
	}, [children, isMobile, registerSubmenuContent, submenuId]);
	if (isMobile) {
		if (!submenuId) {
			throw new Error("Submenu content must be inside DropdownMenuSub.");
		}
		return null;
	}
	return (
		<DropdownMenuContent
			align={align}
			alignOffset={alignOffset}
			className={cn(
				"relative w-auto min-w-36 rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-popover) **:data-[slot$=-item]:data-highlighted:bg-foreground/10 **:data-[slot$=-separator]:bg-foreground/5 **:data-[variant=destructive]:**:text-accent-foreground! **:data-[variant=destructive]:text-accent-foreground! **:data-[slot$=-trigger]:aria-expanded:bg-foreground/10 **:data-[slot$=-item]:focus:bg-foreground/10 **:data-[slot$=-trigger]:focus:bg-foreground/10 **:data-[variant=destructive]:focus:bg-foreground/10!",
				className
			)}
			data-slot="dropdown-menu-sub-content"
			side={side}
			sideOffset={sideOffset}
			{...props}
			withBackdrop={false}
		>
			{children}
		</DropdownMenuContent>
	);
}

export { DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger };
