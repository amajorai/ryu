"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useSyncExternalStore } from "react";
import { tabIds } from "./tab-keys.ts";
import { useRovingTabs } from "./use-roving-tabs.ts";

export interface ExplorerTab {
	readonly id: string;
	readonly label: string;
}

/** The lg breakpoint, where the tab row becomes a column. */
export const EXPLORER_COLUMN_QUERY = "(min-width: 64rem)";

function subscribeColumn(onChange: () => void): () => void {
	const query = window.matchMedia(EXPLORER_COLUMN_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** True from lg up, where the tabs stack; false on the server and on phones. */
function useIsColumn(): boolean {
	return useSyncExternalStore(
		subscribeColumn,
		() => window.matchMedia(EXPLORER_COLUMN_QUERY).matches,
		() => false
	);
}

/** A tab's visible label, localized like the list label. */
function TabLabel({ text }: { text: string }) {
	const localized = useLocalizedText(text, { literal: true });
	return <span className="text-pretty">{localized}</span>;
}

/**
 * The explorer's tab list and panels. Tabs are a scrolling row on phones and a
 * numbered column from lg up; arrow keys in either direction move between
 * them. Every panel is server-rendered; inactive panels carry `hidden`.
 */
export function FeatureExplorerTabs({
	groupId,
	tabs,
	panels,
	label = "Features",
}: {
	groupId: string;
	tabs: readonly ExplorerTab[];
	panels: readonly ReactNode[];
	label?: string;
}) {
	const { selected, setSelected, onKeyDown, registerTab } = useRovingTabs(
		tabs.length,
		"both"
	);
	const tabListLabel = useLocalizedText(label, { literal: true });
	const isColumn = useIsColumn();

	return (
		<div className="grid gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:gap-12">
			<div
				aria-label={typeof tabListLabel === "string" ? tabListLabel : label}
				aria-orientation={isColumn ? "vertical" : "horizontal"}
				className="-mx-6 flex gap-2 overflow-x-auto px-6 pb-1 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0"
				onKeyDown={onKeyDown}
				role="tablist"
			>
				{tabs.map((tab, index) => {
					const ids = tabIds(groupId, tab.id);
					const isSelected = index === selected;
					return (
						<button
							aria-controls={ids.panel}
							aria-selected={isSelected}
							className={cn(
								"group flex min-h-11 shrink-0 items-center gap-3 rounded-full px-4 text-start font-medium text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:rounded-xl lg:py-3",
								isSelected
									? "bg-foreground text-background lg:bg-muted lg:text-foreground"
									: "bg-muted/50 text-muted-foreground hover:text-foreground lg:bg-transparent"
							)}
							id={ids.tab}
							key={tab.id}
							onClick={() => setSelected(index)}
							ref={registerTab(index)}
							role="tab"
							tabIndex={isSelected ? 0 : -1}
							type="button"
						>
							<span
								aria-hidden="true"
								className="hidden font-mono text-muted-foreground text-xs tabular-nums lg:inline"
							>
								{String(index + 1).padStart(2, "0")}
							</span>
							<TabLabel text={tab.label} />
						</button>
					);
				})}
			</div>
			{tabs.map((tab, index) => {
				const ids = tabIds(groupId, tab.id);
				return (
					<div
						aria-labelledby={ids.tab}
						className="min-w-0"
						data-explorer-panel={tab.id}
						hidden={index !== selected}
						id={ids.panel}
						key={tab.id}
						role="tabpanel"
					>
						{panels[index]}
					</div>
				);
			})}
		</div>
	);
}
