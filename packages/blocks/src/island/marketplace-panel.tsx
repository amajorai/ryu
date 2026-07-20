"use client";

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
			<div className="flex items-center gap-1 rounded-full bg-white/5 p-1">
				{(["skill", "mcp"] as const).map((k) => (
					<Button
						className={
							kind === k
								? "flex-1 bg-white/15 text-neutral-100 hover:bg-white/15"
								: "flex-1 text-neutral-400 hover:text-neutral-200"
						}
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
					className="h-7 min-w-0 flex-1 rounded-lg bg-black/30 px-2 py-1 text-neutral-100 text-xs md:text-xs"
					onChange={(e) => onChangeQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							onSearch();
						}
					}}
					placeholder={kind === "skill" ? "Search skills…" : "Search MCP…"}
					type="text"
					value={query}
				/>
				{sources.length > 0 ? (
					<NativeSelect
						className="max-w-[8rem] [&>select]:h-7 [&>select]:bg-black/30 [&>select]:text-neutral-100 [&>select]:text-xs"
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
				) : null}
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading ? (
					<p className="py-6 text-center text-neutral-500 text-xs">Loading…</p>
				) : null}
				{!loading && error ? (
					<p className="py-6 text-center text-red-400 text-xs">{error}</p>
				) : null}
				{loading || error ? null : (
					<div className="flex flex-col gap-1.5">
						{items.length === 0 ? (
							<p className="py-6 text-center text-neutral-500 text-xs">
								Nothing found
							</p>
						) : (
							items.map((item) => (
								<div
									className="flex items-start justify-between gap-2 rounded-lg bg-white/5 p-2"
									key={item.id}
								>
									<div className="min-w-0">
										<p className="truncate font-medium text-neutral-100 text-xs">
											{item.name}
										</p>
										{item.description ? (
											<p className="mt-0.5 line-clamp-2 text-[11px] text-neutral-400">
												{item.description}
											</p>
										) : null}
										{item.subtitle ? (
											<p className="mt-0.5 truncate text-[10px] text-neutral-500">
												{item.subtitle}
											</p>
										) : null}
									</div>
									{item.installed ? (
										<span className="shrink-0 rounded-md bg-emerald-500/20 px-2 py-1 font-medium text-[10px] text-emerald-300">
											Installed
										</span>
									) : (
										<Button
											className="shrink-0 bg-white/10 text-neutral-100 hover:bg-white/20"
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
