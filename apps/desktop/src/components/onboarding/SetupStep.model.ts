import { useEffect, useState } from "react";
import type { CatalogItem, DependencyStatus } from "@/src/lib/services-api.ts";

export function useOnlineStatus() {
	const [online, setOnline] = useState(navigator.onLine);
	useEffect(() => {
		const on = () => setOnline(true);
		const off = () => setOnline(false);
		window.addEventListener("online", on);
		window.addEventListener("offline", off);
		return () => {
			window.removeEventListener("online", on);
			window.removeEventListener("offline", off);
		};
	}, []);
	return online;
}

export interface SetupStepProps {
	nodeUrl: string;
	onInstall: (sidecars: string[], deps: string[]) => void;
	token: string | null;
}

export interface CategoryState {
	expanded: boolean;
	items: CatalogItem[];
	selected: boolean;
	selectedItems: Set<string>;
}

export interface DepCategoryState {
	expanded: boolean;
	items: DependencyStatus[];
	selected: boolean;
	selectedItems: Set<string>;
}

export const CATEGORIES = ["agent", "tool", "provider"] as const;

export const CATEGORY_LABELS = {
	agent: "Agents",
	tool: "Tools",
	provider: "Providers",
} satisfies Record<(typeof CATEGORIES)[number], string>;
