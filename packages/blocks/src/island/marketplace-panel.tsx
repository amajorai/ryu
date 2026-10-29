"use client";
import styles from "./marketplace-panel.module.css";

// The marketplace view inside the expanded island: browse + install skills and
// MCP servers from Core's catalog, with per-kind source switching. Kept compact
// for the small overlay: a searchable list with install buttons, not a full
// master-detail.
//
// Presentational view: the live island wraps this and supplies the catalog data
// (items/sources/loading/error/installing) + the kind/query/source/install
// handlers. Standalone it renders a small demo browse list.

import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select";

export type IslandCatalogKind = "skill" | "mcp";

export interface IslandCatalogItem {
	description?: string | null;
	id: string;
	installed?: boolean;
	name: string;
	subtitle?: string | null;
}

export interface IslandCatalogSource {
	displayName: string;
	id: string;
}

export interface MarketplacePanelViewProps {
	activeSource?: string;
	error?: string | null;
	installing?: ReadonlySet<string>;
	items?: IslandCatalogItem[];
	kind?: IslandCatalogKind;
	loading?: boolean;
	onChangeQuery?: (value: string) => void;
	onInstall?: (id: string) => void;
	onSearch?: () => void;
	onSelectKind?: (kind: IslandCatalogKind) => void;
	onSelectSource?: (id: string) => void;
	query?: string;
	sources?: IslandCatalogSource[];
}

const DEMO_ITEMS: IslandCatalogItem[] = [
	{
		id: "agentbrowser",
		name: "agentbrowser",
		description: "Headless web browsing tool for any agent.",
		installed: true,
	},
	{
		id: "spider",
		name: "spider",
		description: "Fast site crawler and scraper.",
		installed: false,
	},
	{
		id: "promptfoo",
		name: "promptfoo",
		description: "Eval and prompt-version harness.",
		installed: false,
	},
];

const DEMO_SOURCES: IslandCatalogSource[] = [
	{ id: "skills.sh", displayName: "skills.sh" },
];

const EMPTY_SET: ReadonlySet<string> = new Set();

const noop = (): void => {
	// Static-render default; the live island injects the real catalog handlers.
};

export function MarketplacePanelView({
	kind = "skill",
	query = "",
	items = DEMO_ITEMS,
	sources = DEMO_SOURCES,
	activeSource = "skills.sh",
	loading = false,
	error = null,
	installing = EMPTY_SET,
	onSelectKind = noop,
	onChangeQuery = noop,
	onSearch = noop,
	onSelectSource = noop,
	onInstall = noop,
}: MarketplacePanelViewProps) {
	return (
		<div className="flex h-full flex-col gap-2">
			<div className="flex items-center gap-1 rounded-full bg-card p-1">
				{(["skill", "mcp"] as const).map((k) => (
					<Button
						appearance={
							kind === k ? "island-kind-active" : "island-kind-inactive"
						}
						className="flex-1"
						key={k}
						onClick={() => onSelectKind(k)}
						size="xs"
						variant="ghost"
					>
						{k === "skill" ? "Skills" : "MCP"}
					</Button>
				))}
			</div>

			<div className="flex items-center gap-2">
				<Input
					aria-label={kind === "skill" ? "Search skills" : "Search MCP servers"}
					className="min-w-0 flex-1"
					onChange={(e) => onChangeQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							onSearch();
						}
					}}
					placeholder={kind === "skill" ? "Search skills…" : "Search MCP…"}
					type="text"
					value={query}
					variant="island-settings"
				/>
				{sources.length > 0 ? (
					<div className={styles.sourcePicker}>
						<NativeSelect
							className="max-w-[8rem] [&>select]:h-7"
							disabled={loading}
							onChange={(e) => onSelectSource(e.target.value)}
							size="sm"
							value={activeSource}
						>
							{sources.map((s) => (
								<NativeSelectOption key={s.id} value={s.id}>
									{s.displayName}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<p className="py-6 text-center text-muted-foreground text-xs">
						Loading…
					</p>
				) : null}
				{!loading && error ? (
					<p className="py-6 text-center text-status-destructive text-xs">
						{error}
					</p>
				) : null}
				{loading || error ? null : (
					<div className="flex flex-col gap-1.5">
						{items.length === 0 ? (
							<p className="py-6 text-center text-muted-foreground text-xs">
								Nothing found
							</p>
						) : (
							items.map((item) => (
								<div
									className="flex items-start justify-between gap-2 rounded-lg bg-card p-2"
									key={item.id}
								>
									<div className="min-w-0">
										<p className="truncate font-medium text-foreground text-xs">
											{item.name}
										</p>
										{item.description ? (
											<p className="type-caption mt-0.5 line-clamp-2 text-muted-foreground">
												{item.description}
											</p>
										) : null}
										{item.subtitle ? (
											<p className="type-compact mt-0.5 truncate text-muted-foreground">
												{item.subtitle}
											</p>
										) : null}
									</div>
									{item.installed ? (
										<span className="type-compact shrink-0 rounded-md bg-success/20 px-2 py-1 font-medium text-status-success">
											Installed
										</span>
									) : (
										<Button
											appearance="island-panel"
											disabled={installing.has(item.id)}
											onClick={() => onInstall(item.id)}
											size="xs"
											variant="ghost"
										>
											{installing.has(item.id) ? "…" : "Install"}
										</Button>
									)}
								</div>
							))
						)}
					</div>
				)}
			</div>
		</div>
	);
}
