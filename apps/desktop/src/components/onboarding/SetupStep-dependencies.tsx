// apps/desktop/src/components/onboarding/SetupStep-dependencies.tsx

import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@/lib/utils.ts";
import type { DepCategoryState } from "./SetupStep.model.ts";

interface SetupStepDependencyCategoryProps {
	depCategoryState: DepCategoryState;
	toggleDepCategory: () => void;
	toggleDepExpand: () => void;
	toggleDepItem: (name: string) => void;
}

export function SetupStepDependencyCategory({
	depCategoryState,
	toggleDepCategory,
	toggleDepExpand,
	toggleDepItem,
}: SetupStepDependencyCategoryProps) {
	const tl = useLiteralMessages();
	return (
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
					{tl("{size} selected", {
						size: String(depCategoryState.selectedItems.size),
					})}
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
						<div className="flex items-center gap-3 px-3 py-2" key={dep.name}>
							<button
								aria-checked={depCategoryState.selectedItems.has(dep.name)}
								aria-label={
									depCategoryState.selectedItems.has(dep.name)
										? tl("Deselect {name}", { name: dep.name })
										: tl("Select {name}", { name: dep.name })
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
	);
}
