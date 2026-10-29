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
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";

export type ViewMode = "grid" | "list" | "showcase";
export type LibraryViewMode = ViewMode | "graph";

/** Each mode's button. Only Showcase carries a `title` tooltip. */
const VIEW_MODE_BUTTONS: Record<
	LibraryViewMode,
	{ icon: IconSvgElement; label: string; title?: string }
> = {
	graph: { icon: HierarchyIcon, label: "Relations view" },
	grid: { icon: GridViewIcon, label: "Grid view" },
	list: { icon: ListViewIcon, label: "List view" },
	showcase: {
		icon: SparklesIcon,
		label: "Showcase view",
		title: "Showcase view",
	},
};

/** The segmented control both toggles render: one icon button per mode. */
function ViewModeButtons<M extends LibraryViewMode>({
	modes,
	onChange,
	value,
}: {
	modes: readonly M[];
	onChange: (mode: M) => void;
	value: M;
}) {
	return (
		<div
			className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
			data-slot="view-toggle"
			data-view-mode={value}
		>
			{modes.map((mode) => {
				const { icon, label, title } = VIEW_MODE_BUTTONS[mode];
				return (
					<Button
						aria-label={label}
						aria-pressed={value === mode}
						key={mode}
						onClick={() => onChange(mode)}
						size="icon-sm"
						title={title}
						variant={value === mode ? "secondary" : "ghost"}
					>
						<HugeiconsIcon className="size-4" icon={icon} />
					</Button>
				);
			})}
		</div>
	);
}

export function ViewToggle({
	value,
	onChange,
	showShowcase = false,
}: {
	showShowcase?: boolean;
	value: ViewMode;
	onChange: (mode: ViewMode) => void;
}) {
	const modes: ViewMode[] = showShowcase
		? ["grid", "list", "showcase"]
		: ["grid", "list"];
	return <ViewModeButtons modes={modes} onChange={onChange} value={value} />;
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
	const modes: LibraryViewMode[] = ["grid", "list"];
	if (showShowcase) {
		modes.push("showcase");
	}
	if (showGraph) {
		modes.push("graph");
	}
	return <ViewModeButtons modes={modes} onChange={onChange} value={value} />;
}
