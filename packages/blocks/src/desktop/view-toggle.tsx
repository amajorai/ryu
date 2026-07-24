"use client";

// A small grid/list view switcher reused by the Store catalog sections
// (Engines, Agents). It is purely controlled — the persisted preference lives
// in the live app (`useStoreViewMode`) and the storyboard passes a fixed value.
// Sharing it here keeps the toggle and the row/grid layouts in one place so the
// real desktop and the storyboard stay in lockstep.

import { GridViewIcon, ListViewIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";

export type ViewMode = "grid" | "list";

export function ViewToggle({
	value,
	onChange,
}: {
	value: ViewMode;
	onChange: (mode: ViewMode) => void;
}) {
	return (
		<div className="inline-flex items-center gap-0.5 rounded-md border p-0.5">
			<Button
				aria-label="Grid view"
				aria-pressed={value === "grid"}
				onClick={() => onChange("grid")}
				size="icon-sm"
				variant={value === "grid" ? "secondary" : "ghost"}
			>
				<HugeiconsIcon className="size-4" icon={GridViewIcon} />
			</Button>
			<Button
				aria-label="List view"
				aria-pressed={value === "list"}
				onClick={() => onChange("list")}
				size="icon-sm"
				variant={value === "list" ? "secondary" : "ghost"}
			>
				<HugeiconsIcon className="size-4" icon={ListViewIcon} />
			</Button>
		</div>
	);
}
