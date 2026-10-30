"use client";

import { createContext, useContext } from "react";

export interface SidebarContextProps {
	isMobile: boolean;
	open: boolean;
	openMobile: boolean;
	setOpen: (open: boolean) => void;
	setOpenMobile: (open: boolean) => void;
	state: "expanded" | "collapsed";
	toggleSidebar: () => void;
}

export const SidebarContext = createContext<SidebarContextProps | null>(null);

export function useSidebar() {
	const context = useContext(SidebarContext);
	if (!context) {
		throw new Error("useSidebar must be used within a SidebarProvider.");
	}

	return context;
}
