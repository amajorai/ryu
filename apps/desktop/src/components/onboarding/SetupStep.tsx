// apps/desktop/src/components/onboarding/SetupStep.tsx

import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	WifiOff01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";

import { cn } from "@/lib/utils.ts";

import {
	CATEGORIES,
	CATEGORY_LABELS,
	type SetupStepProps,
} from "./SetupStep.model.ts";
import { useSetupStepState } from "./SetupStep.state.ts";
import { SetupStepDependencyCategory } from "./SetupStep-dependencies.tsx";

export function SetupStep({ nodeUrl, token, onInstall }: SetupStepProps) {
	const tl = useLiteralMessages();
	const {
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
	} = useSetupStepState({ nodeUrl, onInstall, token });

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
						className="h-5 w-5 text-status-warning"
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
					<h2 className="mb-1 font-semibold text-lg tracking-tight">
						Get Ryu ready
					</h2>
					<p className="text-muted-foreground text-sm">
						We'll install what you need to get started.
					</p>
				</div>

				{!online && (
					<div className="flex items-center gap-2 text-sm text-status-warning">
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
								<span
									className="truncate text-muted-foreground"
									title={item.description}
								>
									{item.description}
								</span>
							)}
						</div>
					))}
					{missingDeps.length > 0 && (
						<div className="flex items-center gap-3 text-muted-foreground text-sm">
							<div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-muted-foreground" />
							<span>
								{tl("{names} (auto-detected)", {
									names: missingDeps.map((d) => d.name).join(", "),
								})}
							</span>
						</div>
					)}
				</div>

				<div className="flex flex-col gap-2">
					<Button
						className="h-10 w-full"
						disabled={!online}
						onClick={handleGetStarted}
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
				<h2 className="mb-1 font-semibold text-lg tracking-tight">
					Choose what to install
				</h2>
				<p className="text-muted-foreground text-sm">
					Select categories or individual items.
				</p>
			</div>

			{!online && (
				<div className="flex items-center gap-2 text-sm text-status-warning">
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
											? tl("Deselect {name}", { name: CATEGORY_LABELS[cat] })
											: tl("Select {name}", { name: CATEGORY_LABELS[cat] })
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
									{tl("{size} selected", {
										size: String(state.selectedItems.size),
									})}
								</span>
								<button
									aria-label={
										state.expanded
											? tl("Collapse {name}", { name: CATEGORY_LABELS[cat] })
											: tl("Expand {name}", { name: CATEGORY_LABELS[cat] })
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
														? tl("Deselect {name}", { name: item.displayName })
														: tl("Select {name}", { name: item.displayName })
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
												<span
													className="truncate text-muted-foreground text-xs"
													title={item.description}
												>
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
					<SetupStepDependencyCategory
						depCategoryState={depCategoryState}
						toggleDepCategory={toggleDepCategory}
						toggleDepExpand={toggleDepExpand}
						toggleDepItem={toggleDepItem}
					/>
				)}
			</div>

			<div className="flex gap-2 pt-1">
				<Button onClick={() => setCustomizing(false)} size="sm" variant="ghost">
					Back
				</Button>
				<Button
					className="h-10 flex-1"
					disabled={!online}
					onClick={handleInstallSelected}
					variant="mono"
				>
					Install selected
				</Button>
			</div>
		</div>
	);
}
