"use client";

// A small grid/list view switcher reused by the Store catalog sections
// (Engines, Agents). It is purely controlled — the persisted preference lives
// in the live app (`useStoreViewMode`) and the storyboard passes a fixed value.
// Sharing it here keeps the toggle and the row/grid layouts in one place so the
// real desktop and the storyboard stay in lockstep.

import {
	GridViewIcon,
	HierarchyIcon,
	ListViewIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";

export type ViewMode = "grid" | "list" | "showcase";
export type LibraryViewMode = ViewMode | "graph";

export function ViewToggle({
	value,
	onChange,
	showShowcase = false,
}: {
	showShowcase?: boolean;
	value: ViewMode;
	onChange: (mode: ViewMode) => void;
}) {
	return (
		<div
			className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
			data-slot="view-toggle"
			data-view-mode={value}
		>
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
			{showShowcase ? (
				<Button
					aria-label="Showcase view"
					aria-pressed={value === "showcase"}
					onClick={() => onChange("showcase")}
					size="icon-sm"
					title="Showcase view"
					variant={value === "showcase" ? "secondary" : "ghost"}
				>
					<HugeiconsIcon className="size-4" icon={SparklesIcon} />
				</Button>
			) : null}
		</div>
	);
}

/** Library view switcher. Relations and Showcase are opt-in additions to the
 * shared Grid/List control because only some Library collections support them. */
export function LibraryViewToggle({
	value,
	onChange,
	showGraph = false,
	showShowcase = false,
}: {
	showGraph?: boolean;
	showShowcase?: boolean;
	value: LibraryViewMode;
	onChange: (mode: LibraryViewMode) => void;
}) {
	return (
		<div
			className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
			data-slot="view-toggle"
			data-view-mode={value}
		>
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
			{showShowcase ? (
				<Button
					aria-label="Showcase view"
					aria-pressed={value === "showcase"}
					onClick={() => onChange("showcase")}
					size="icon-sm"
					title="Showcase view"
					variant={value === "showcase" ? "secondary" : "ghost"}
				>
					<HugeiconsIcon className="size-4" icon={SparklesIcon} />
				</Button>
			) : null}
			{showGraph ? (
				<Button
					aria-label="Relations view"
					aria-pressed={value === "graph"}
					onClick={() => onChange("graph")}
					size="icon-sm"
					variant={value === "graph" ? "secondary" : "ghost"}
				>
					<HugeiconsIcon className="size-4" icon={HierarchyIcon} />
				</Button>
			) : null}
		</div>
	);
}
