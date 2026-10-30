"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
	type ComponentProps,
	type ReactNode,
	useCallback,
	useRef,
	useState,
} from "react";
import { useIsMobile } from "../hooks/use-mobile.ts";
import { Drawer } from "./drawer.tsx";
import { DropdownMenuContent } from "./dropdown-menu-content.tsx";
import {
	createDrawerChangeDetails,
	DropdownMenuContext,
	type MenuContent,
	type MobileSubmenu,
} from "./dropdown-menu-context.ts";
import {
	DropdownMenuCheckboxItem,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
} from "./dropdown-menu-items.tsx";
import {
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
} from "./dropdown-menu-sub.tsx";
import { DropdownMenuTrigger } from "./dropdown-menu-trigger.tsx";
import { usePortalContainer } from "./portal-container.tsx";

function DropdownMenu({
	children,
	defaultOpen = false,
	modal,
	onOpenChange,
	open: controlledOpen,
	...props
}: MenuPrimitive.Root.Props) {
	const isMobile = useIsMobile();
	const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
	const open = controlledOpen ?? uncontrolledOpen;
	const openRef = useRef(open);
	openRef.current = open;
	const [submenuPath, setSubmenuPath] = useState<string[]>([]);
	const [submenus, setSubmenus] = useState<Map<string, MobileSubmenu>>(
		() => new Map()
	);
	const setOpen = useCallback(
		(
			nextOpen: boolean,
			eventDetails?: MenuPrimitive.Root.ChangeEventDetails
		) => {
			if (openRef.current === nextOpen) {
				return;
			}
			const details = eventDetails ?? createDrawerChangeDetails();
			onOpenChange?.(nextOpen, details);
			if (details.isCanceled) {
				return;
			}
			openRef.current = nextOpen;
			if (controlledOpen === undefined) {
				setUncontrolledOpen(nextOpen);
			}
			if (!nextOpen) {
				setSubmenuPath([]);
			}
		},
		[controlledOpen, onOpenChange]
	);
	const registerSubmenuTitle = useCallback((id: string, title: ReactNode) => {
		setSubmenus((current) => {
			if (current.get(id)?.title === title) {
				return current;
			}
			const next = new Map(current);
			next.set(id, { ...next.get(id), title });
			return next;
		});
	}, []);
	const registerSubmenuContent = useCallback(
		(id: string, content: MenuContent) => {
			setSubmenus((current) => {
				if (current.get(id)?.content === content) {
					return current;
				}
				const next = new Map(current);
				next.set(id, { ...next.get(id), content });
				return next;
			});
		},
		[]
	);
	const goBack = useCallback(() => {
		setSubmenuPath((current) => current.slice(0, -1));
	}, []);
	const context = {
		goBack,
		isMobile,
		open,
		registerSubmenuContent,
		registerSubmenuTitle,
		setOpen,
		setSubmenuPath,
		submenuPath,
		submenus,
	};

	const menu = (
		<DropdownMenuContext.Provider value={context}>
			<MenuPrimitive.Root
				data-slot="dropdown-menu"
				{...props}
				defaultOpen={undefined}
				modal={isMobile ? false : modal}
				onOpenChange={(nextOpen, eventDetails) =>
					setOpen(nextOpen, eventDetails)
				}
				open={open}
			>
				{children}
			</MenuPrimitive.Root>
		</DropdownMenuContext.Provider>
	);

	const mobileDrawerProps: ComponentProps<typeof Drawer> = {
		onOpenChange: setOpen,
		open,
	};
	if (modal !== undefined) {
		mobileDrawerProps.modal = modal;
	}

	return isMobile ? <Drawer {...mobileDrawerProps}>{menu}</Drawer> : menu;
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
	return (
		<MenuPrimitive.Portal
			container={usePortalContainer()}
			data-slot="dropdown-menu-portal"
			{...props}
		/>
	);
}

export {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuPortal,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
};
