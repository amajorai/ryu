import type { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
	createContext,
	type Dispatch,
	type ReactNode,
	type SetStateAction,
	useContext,
} from "react";

export type MenuContent = MenuPrimitive.Popup.Props["children"];

export interface MobileSubmenu {
	content?: MenuContent;
	title?: ReactNode;
}

export interface DropdownMenuContextValue {
	goBack: () => void;
	isMobile: boolean;
	open: boolean;
	registerSubmenuContent: (id: string, content: MenuContent) => void;
	registerSubmenuTitle: (id: string, title: ReactNode) => void;
	setOpen: (open: boolean) => void;
	setSubmenuPath: Dispatch<SetStateAction<string[]>>;
	submenuPath: string[];
	submenus: ReadonlyMap<string, MobileSubmenu>;
}

export const DropdownMenuContext =
	createContext<DropdownMenuContextValue | null>(null);
export const DropdownMenuSubContext = createContext<string | null>(null);

export function useDropdownMenuContext() {
	const context = useContext(DropdownMenuContext);
	if (!context) {
		throw new Error(
			"Dropdown menu parts must be rendered inside DropdownMenu."
		);
	}
	return context;
}

export function createDrawerChangeDetails(): MenuPrimitive.Root.ChangeEventDetails {
	let cancelled = false;
	let propagationAllowed = false;
	return {
		reason: "imperative-action",
		event: new Event("dropdrawer-change"),
		trigger: undefined,
		get isCanceled() {
			return cancelled;
		},
		get isPropagationAllowed() {
			return propagationAllowed;
		},
		cancel() {
			cancelled = true;
		},
		allowPropagation() {
			propagationAllowed = true;
		},
		preventUnmountOnClose: () => undefined,
	};
}
