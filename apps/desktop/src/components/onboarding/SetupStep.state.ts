import { useEffect, useState } from "react";
import {
	type CatalogItem,
	type DependencyStatus,
	fetchCatalog,
	fetchDependencies,
} from "@/src/lib/services-api.ts";
import {
	CATEGORIES,
	type CategoryState,
	type DepCategoryState,
	type SetupStepProps,
	useOnlineStatus,
} from "./SetupStep.model.ts";

interface SetupStepStateInput {
	nodeUrl: SetupStepProps["nodeUrl"];
	onInstall: SetupStepProps["onInstall"];
	token: SetupStepProps["token"];
}

/** Catalog and dependency loading plus the category and item selection model. */
export function useSetupStepState({
	nodeUrl,
	onInstall,
	token,
}: SetupStepStateInput) {
	const online = useOnlineStatus();
	const [customizing, setCustomizing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [retryCount, setRetryCount] = useState(0);
	const [catalog, setCatalog] = useState<CatalogItem[]>([]);
	const [deps, setDeps] = useState<DependencyStatus[]>([]);
	const [categoryStates, setCategoryStates] = useState<
		Record<string, CategoryState>
	>({});
	const [depCategoryState, setDepCategoryState] =
		useState<DepCategoryState | null>(null);
	useEffect(() => {
		let cancelled = false;

		const load = async () => {
			const MAX_ATTEMPTS = 5;
			const RETRY_DELAY_MS = 1500;

			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
				if (cancelled) {
					return;
				}
				try {
					const [items, depStatus] = await Promise.all([
						fetchCatalog(nodeUrl, token),
						fetchDependencies(nodeUrl, token),
					]);
					if (cancelled) {
						return;
					}
					const active = items.filter(
						(i) => !i.deprecated && i.installState === "not_installed"
					);
					setCatalog(active);
					setDeps(depStatus);

					const states: Record<string, CategoryState> = {};
					for (const cat of CATEGORIES) {
						const catItems = active.filter((i) => i.category === cat);
						states[cat] = {
							selected: true,
							expanded: false,
							items: catItems,
							selectedItems: new Set(catItems.map((i) => i.name)),
						};
					}
					setCategoryStates(states);

					setDepCategoryState({
						selected: depStatus.some((d) => !d.installed),
						expanded: false,
						items: depStatus.filter((d) => !d.installed),
						selectedItems: new Set(
							depStatus.filter((d) => !d.installed).map((d) => d.name)
						),
					});
					setLoading(false);
					return;
				} catch {
					if (attempt < MAX_ATTEMPTS - 1) {
						await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
					}
				}
			}
			if (!cancelled) {
				setLoadError(
					navigator.onLine
						? "Could not load available installs. Check your connection."
						: "No internet connection. Connect to the internet to download dependencies."
				);
				setLoading(false);
			}
		};

		load();
		return () => {
			cancelled = true;
		};
		// `retryCount` is load-bearing, not noise: both the "Try again" button and
		// the back-online effect below only bump it, so dropping it from the deps
		// leaves onboarding on a permanent spinner with no way out. A lint autofix
		// has emptied this array once already.
	}, [nodeUrl, token, retryCount]);
	useEffect(() => {
		if (online && loadError) {
			setLoadError(null);
			setLoading(true);
			setRetryCount((c) => c + 1);
		}
	}, [online, loadError]);
	const recommended = catalog.filter((i) => i.recommended);
	const missingDeps = deps.filter((d) => !d.installed);
	const toggleCategory = (cat: string) => {
		setCategoryStates((prev) => {
			const current = prev[cat];
			const nowSelected = !current.selected;
			return {
				...prev,
				[cat]: {
					...current,
					selected: nowSelected,
					selectedItems: nowSelected
						? new Set(current.items.map((i) => i.name))
						: new Set(),
				},
			};
		});
	};
	const toggleExpand = (cat: string) => {
		setCategoryStates((prev) => ({
			...prev,
			[cat]: { ...prev[cat], expanded: !prev[cat].expanded },
		}));
	};
	const toggleItem = (cat: string, name: string) => {
		setCategoryStates((prev) => {
			const current = prev[cat];
			const next = new Set(current.selectedItems);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return {
				...prev,
				[cat]: {
					...current,
					selectedItems: next,
					selected: next.size === current.items.length,
				},
			};
		});
	};
	const toggleDepCategory = () => {
		setDepCategoryState((prev) => {
			if (!prev) {
				return prev;
			}
			const nowSelected = !prev.selected;
			return {
				...prev,
				selected: nowSelected,
				selectedItems: nowSelected
					? new Set(prev.items.map((i) => i.name))
					: new Set(),
			};
		});
	};
	const toggleDepItem = (name: string) => {
		setDepCategoryState((prev) => {
			if (!prev) {
				return prev;
			}
			const next = new Set(prev.selectedItems);
			if (next.has(name)) {
				next.delete(name);
			} else {
				next.add(name);
			}
			return {
				...prev,
				selectedItems: next,
				selected: next.size === prev.items.length,
			};
		});
	};
	const toggleDepExpand = () => {
		setDepCategoryState((prev) =>
			prev ? { ...prev, expanded: !prev.expanded } : prev
		);
	};
	const handleGetStarted = () => {
		const selectedDeps = depCategoryState?.selectedItems
			? [...depCategoryState.selectedItems]
			: [];
		onInstall(
			recommended.map((i) => i.name),
			selectedDeps
		);
	};
	const handleInstallSelected = () => {
		const sidecars: string[] = [];
		for (const state of Object.values(categoryStates)) {
			for (const name of state.selectedItems) {
				sidecars.push(name);
			}
		}
		const selectedDeps = depCategoryState
			? [...depCategoryState.selectedItems]
			: [];
		onInstall([...new Set(sidecars)], selectedDeps);
	};
	return {
		categoryStates,
		customizing,
		depCategoryState,
		handleGetStarted,
		handleInstallSelected,
		loadError,
		loading,
		missingDeps,
		online,
		recommended,
		setCustomizing,
		setLoadError,
		setLoading,
		setRetryCount,
		toggleCategory,
		toggleDepCategory,
		toggleDepExpand,
		toggleDepItem,
		toggleExpand,
		toggleItem,
	};
}
