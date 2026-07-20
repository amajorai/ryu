// apps/desktop/src/components/onboarding/SetupStep.tsx

import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	WifiOff01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils.ts";
import {
	type CatalogItem,
	type DependencyStatus,
	fetchCatalog,
	fetchDependencies,
} from "@/src/lib/services-api.ts";

function useOnlineStatus() {
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

interface SetupStepProps {
	nodeUrl: string;
	onInstall: (sidecars: string[], deps: string[]) => void;
	token: string | null;
}

interface CategoryState {
	expanded: boolean;
	items: CatalogItem[];
	selected: boolean;
	selectedItems: Set<string>;
}

interface DepCategoryState {
	expanded: boolean;
	items: DependencyStatus[];
	selected: boolean;
	selectedItems: Set<string>;
}

const CATEGORIES = ["agent", "tool", "provider"] as const;
const CATEGORY_LABELS: Record<(typeof CATEGORIES)[number], string> = {
	agent: "Agents",
	tool: "Tools",
	provider: "Providers",
};

export function SetupStep({ nodeUrl, token, onInstall }: SetupStepProps) {
	const online = useOnlineStatus();
	const [customizing, setCustomizing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [_retryCount, setRetryCount] = useState(0);
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
						? "Could not load available installs — check your connection"
						: "No internet connection. Connect to the internet to download dependencies."
				);
				setLoading(false);
			}
		};

		load();
		return () => {
			cancelled = true;
		};
	}, [nodeUrl, token]);

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

	if (loading) {
		return (
			<div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
				Loading…
			</div>
		);
	}

	if (loadError) {
		return (
			<div className="flex flex-col items-center gap-3 py-12 text-muted-foreground text-sm">
				{!online && (
					<HugeiconsIcon
						className="h-5 w-5 text-warning"
						icon={WifiOff01Icon}
					/>
				)}
				<p className="text-center">{loadError}</p>
				{online && (
					<button
						className="underline underline-offset-2 transition-colors hover:text-foreground"
						onClick={() => {
							setLoadError(null);
							setLoading(true);
							setRetryCount((c) => c + 1);
						}}
						type="button"
					>
						Try again
					</button>
				)}
			</div>
		);
	}

	if (!customizing) {
		return (
			<div className="flex flex-col gap-6">
				<div>
					<h2 className="mb-1 font-semibold text-xl">Get Ryu ready</h2>
					<p className="text-muted-foreground text-sm">
						We'll install what you need to get started.
					</p>
				</div>

				{!online && (
					<div className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning dark:text-warning">
						<HugeiconsIcon
							className="h-4 w-4 flex-shrink-0"
							icon={WifiOff01Icon}
						/>
						<span>
							No internet connection. You need to be connected to download
							dependencies.
						</span>
					</div>
				)}

				<div className="space-y-2">
					{recommended.map((item) => (
						<div className="flex items-center gap-3 text-sm" key={item.name}>
							<div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
							<span className="font-medium">{item.displayName}</span>
							{item.description && (
								<span className="truncate text-muted-foreground">
									— {item.description}
								</span>
							)}
						</div>
					))}
					{missingDeps.length > 0 && (
						<div className="flex items-center gap-3 text-muted-foreground text-sm">
							<div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground/40" />
							<span>
								{missingDeps.map((d) => d.name).join(", ")} (auto-detected)
							</span>
						</div>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<Button
						className="w-full"
						disabled={!online}
						onClick={handleGetStarted}
						size="lg"
						variant="mono"
					>
						Get started
					</Button>
					<button
						className="text-muted-foreground text-sm underline underline-offset-2 transition-colors hover:text-foreground"
						onClick={() => setCustomizing(true)}
						type="button"
					>
						Choose what to install
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h2 className="mb-1 font-semibold text-xl">Choose what to install</h2>
				<p className="text-muted-foreground text-sm">
					Select categories or individual items.
				</p>
			</div>

			{!online && (
				<div className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-sm text-warning dark:text-warning">
					<HugeiconsIcon
						className="h-4 w-4 flex-shrink-0"
						icon={WifiOff01Icon}
					/>
					<span>
						No internet connection. You need to be connected to download
						dependencies.
					</span>
				</div>
			)}

			<div className="space-y-2">
				{CATEGORIES.map((cat) => {
					const state = categoryStates[cat];
					if (!state || state.items.length === 0) {
						return null;
					}
					return (
						<div className="overflow-hidden rounded-lg bg-muted/20" key={cat}>
							<div className="flex items-center gap-3 bg-muted/30 px-3 py-2.5">
								<button
									aria-checked={state.selected}
									aria-label={
										state.selected
											? `Deselect ${CATEGORY_LABELS[cat]}`
											: `Select ${CATEGORY_LABELS[cat]}`
									}
									className={cn(
										"h-4 w-4 flex-shrink-0 rounded border-2 transition-colors",
										state.selected
											? "border-primary bg-primary"
											: "border-muted-foreground/40"
									)}
									onClick={() => toggleCategory(cat)}
									role="checkbox"
									type="button"
								/>
								<span className="flex-1 font-medium text-sm">
									{CATEGORY_LABELS[cat]}
								</span>
								<span className="text-muted-foreground text-xs">
									{state.selectedItems.size} selected
								</span>
								<button
									aria-label={
										state.expanded
											? `Collapse ${CATEGORY_LABELS[cat]}`
											: `Expand ${CATEGORY_LABELS[cat]}`
									}
									className="text-muted-foreground hover:text-foreground"
									onClick={() => toggleExpand(cat)}
									type="button"
								>
									{state.expanded ? (
										<HugeiconsIcon className="h-4 w-4" icon={ArrowDown01Icon} />
									) : (
										<HugeiconsIcon
											className="h-4 w-4"
											icon={ArrowRight01Icon}
										/>
									)}
								</button>
							</div>
							{state.expanded && (
								<div>
									{state.items.map((item) => (
										<div
											className="flex items-center gap-3 px-3 py-2"
											key={item.name}
										>
											<button
												aria-checked={state.selectedItems.has(item.name)}
												aria-label={
													state.selectedItems.has(item.name)
														? `Deselect ${item.displayName}`
														: `Select ${item.displayName}`
												}
												className={cn(
													"h-3.5 w-3.5 flex-shrink-0 rounded border-2 transition-colors",
													state.selectedItems.has(item.name)
														? "border-primary bg-primary"
														: "border-muted-foreground/40"
												)}
												onClick={() => toggleItem(cat, item.name)}
												role="checkbox"
												type="button"
											/>
											<span className="font-medium text-sm">
												{item.displayName}
											</span>
											{item.description && (
												<span className="truncate text-muted-foreground text-xs">
													{item.description}
												</span>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					);
				})}

				{depCategoryState && depCategoryState.items.length > 0 && (
					<div className="overflow-hidden rounded-lg bg-muted/20">
						<div className="flex items-center gap-3 bg-muted/30 px-3 py-2.5">
							<button
								aria-checked={depCategoryState.selected}
								aria-label={
									depCategoryState.selected
										? "Deselect Dependencies"
										: "Select Dependencies"
								}
								className={cn(
									"h-4 w-4 flex-shrink-0 rounded border-2 transition-colors",
									depCategoryState.selected
										? "border-primary bg-primary"
										: "border-muted-foreground/40"
								)}
								onClick={toggleDepCategory}
								role="checkbox"
								type="button"
							/>
							<span className="flex-1 font-medium text-sm">Dependencies</span>
							<span className="text-muted-foreground text-xs">
								{depCategoryState.selectedItems.size} selected
							</span>
							<button
								aria-label={
									depCategoryState.expanded
										? "Collapse Dependencies"
										: "Expand Dependencies"
								}
								className="text-muted-foreground hover:text-foreground"
								onClick={toggleDepExpand}
								type="button"
							>
								{depCategoryState.expanded ? (
									<HugeiconsIcon className="h-4 w-4" icon={ArrowDown01Icon} />
								) : (
									<HugeiconsIcon className="h-4 w-4" icon={ArrowRight01Icon} />
								)}
							</button>
						</div>
						{depCategoryState.expanded && (
							<div>
								{depCategoryState.items.map((dep) => (
									<div
										className="flex items-center gap-3 px-3 py-2"
										key={dep.name}
									>
										<button
											aria-checked={depCategoryState.selectedItems.has(
												dep.name
											)}
											aria-label={
												depCategoryState.selectedItems.has(dep.name)
													? `Deselect ${dep.name}`
													: `Select ${dep.name}`
											}
											className={cn(
												"h-3.5 w-3.5 flex-shrink-0 rounded border-2 transition-colors",
												depCategoryState.selectedItems.has(dep.name)
													? "border-primary bg-primary"
													: "border-muted-foreground/40"
											)}
											onClick={() => toggleDepItem(dep.name)}
											role="checkbox"
											type="button"
										/>
										<span className="font-medium text-sm">{dep.name}</span>
									</div>
								))}
							</div>
						)}
					</div>
				)}
			</div>

			<div className="flex gap-2 pt-1">
				<Button onClick={() => setCustomizing(false)} size="sm" variant="ghost">
					Back
				</Button>
				<Button
					className="flex-1"
					disabled={!online}
					onClick={handleInstallSelected}
					size="lg"
					variant="mono"
				>
					Install selected
				</Button>
			</div>
		</div>
	);
}
