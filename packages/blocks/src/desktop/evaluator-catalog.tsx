"use client";

// Presentational layer of the shared evaluator catalog — one categorized picker
// mounted in BOTH desktop surfaces: the gateway policy surface (inline
// guardrails) and the agent evals surface (offline scoring). The live app wires
// real data + handlers; the storyboard can render the same view with mock data.
//
// Everything here is presentational: props + no-op handlers, no hooks at module
// scope, no Tauri / context / stores / `@/...` imports. Only `@ryu/ui/*`, icons,
// and `react` types. The surface-specific control (an inline switch + action
// select, or an offline checkbox) is injected per item via `renderControl`, so
// this component stays generic across both modes.

import {
	Add01Icon,
	Delete01Icon,
	Search01Icon,
	ShieldIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import { cn } from "@ryu/ui/lib/utils";
import type { ReactNode } from "react";
import { useMemo } from "react";

/** Which surface is presenting the catalog. Filters items by capability. */
export type EvaluatorCatalogMode = "inline" | "offline";

/**
 * Presentational shape for one catalog item — a decoupled subset of the wire
 * `Evaluator` so the block never imports app types. The container maps the wire
 * shape onto this.
 */
export interface EvaluatorCatalogItem {
	/** `false` for user-created ("create from scratch") evaluators. */
	builtin: boolean;
	/** May run inline as a guardrail. */
	capInline: boolean;
	/** May run offline over a dataset. */
	capOffline: boolean;
	/** snake_case category, e.g. "security", "quality", "custom". */
	category: string;
	description: string;
	/** Honesty flag: wired to real execution. */
	enforced: boolean;
	id: string;
	/** Impl kind: "regex" | "heuristic" | "llm_judge" | "code" | "builtin". */
	implKind: string;
	name: string;
	/** snake_case target, e.g. "input", "output", "conversation". */
	target: string;
}

export interface EvaluatorCatalogProps {
	/** Read-only / unreachable: disables create buttons + delete. */
	disabled?: boolean;
	/** Copy shown when no items match the current mode + search. */
	emptyLabel?: string;
	error?: string | null;
	items: EvaluatorCatalogItem[];
	loading?: boolean;
	mode: EvaluatorCatalogMode;
	/** Launch the Code create-from-scratch editor. */
	onCreateCode?: () => void;
	/** Launch the LLM-as-a-Judge create-from-scratch editor. */
	onCreateJudge?: () => void;
	/** Delete a custom (builtin === false) evaluator. */
	onDeleteCustom?: (id: string) => void;
	onSearchChange: (value: string) => void;
	/** Surface-specific control on the right of each row (switch / checkbox / …). */
	renderControl?: (item: EvaluatorCatalogItem) => ReactNode;
	search: string;
}

/** Section order + display labels, matching the product screenshot's tabs. */
const CATEGORY_ORDER: { key: string; label: string }[] = [
	{ key: "security", label: "Security" },
	{ key: "safety", label: "Safety" },
	{ key: "quality", label: "Quality" },
	{ key: "conversation", label: "Conversation" },
	{ key: "trajectory", label: "Trajectory" },
	{ key: "image", label: "Image" },
	{ key: "voice", label: "Voice" },
	{ key: "custom", label: "Custom" },
];

const CATEGORY_RANK: Record<string, number> = CATEGORY_ORDER.reduce(
	(acc, c, i) => {
		acc[c.key] = i;
		return acc;
	},
	{} as Record<string, number>
);

const IMPL_LABELS: Record<string, string> = {
	regex: "Regex",
	heuristic: "Heuristic",
	llm_judge: "LLM judge",
	code: "Code",
	builtin: "Built-in",
};

function matchesSearch(item: EvaluatorCatalogItem, q: string): boolean {
	if (!q) {
		return true;
	}
	const needle = q.toLowerCase();
	return (
		item.name.toLowerCase().includes(needle) ||
		item.description.toLowerCase().includes(needle) ||
		item.id.toLowerCase().includes(needle)
	);
}

/** One evaluator row: identity + badges on the left, injected control on the right. */
function EvaluatorRow({
	item,
	mode,
	control,
	onDelete,
	deleteDisabled,
}: {
	item: EvaluatorCatalogItem;
	mode: EvaluatorCatalogMode;
	control?: ReactNode;
	onDelete?: () => void;
	deleteDisabled?: boolean;
}) {
	// Enforcement honesty is only meaningful for the inline surface (a catalogued
	// but unwired detector silently no-ops). Offline scoring runs regardless, so
	// there the run-time `executed` flag carries the honesty instead.
	const showEnforced = mode === "inline";
	return (
		<div className="flex items-start justify-between gap-3 rounded-lg border bg-card/40 p-3">
			<div className="flex min-w-0 flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="truncate font-medium text-sm">{item.name}</span>
					<Badge className="px-1.5 py-0 text-[10px]" variant="outline">
						{IMPL_LABELS[item.implKind] ?? item.implKind}
					</Badge>
					{item.capInline ? (
						<Badge className="px-1.5 py-0 text-[10px]" variant="secondary">
							Inline
						</Badge>
					) : null}
					{item.capOffline ? (
						<Badge className="px-1.5 py-0 text-[10px]" variant="secondary">
							Offline
						</Badge>
					) : null}
					{showEnforced ? (
						<span
							className={cn(
								"text-[10px]",
								item.enforced ? "text-success" : "text-muted-foreground"
							)}
						>
							{item.enforced ? "● Enforced" : "○ Not yet enforced"}
						</span>
					) : null}
				</div>
				<p className="line-clamp-2 text-muted-foreground text-xs">
					{item.description}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-1.5">
				{control}
				{item.builtin ? null : onDelete ? (
					<Button
						aria-label={`Delete ${item.name}`}
						disabled={deleteDisabled}
						onClick={onDelete}
						size="icon-sm"
						variant="ghost"
					>
						<HugeiconsIcon
							className="size-3.5 text-muted-foreground"
							icon={Delete01Icon}
						/>
					</Button>
				) : null}
			</div>
		</div>
	);
}

/**
 * The shared evaluator catalog: a search header, a create-from-scratch section
 * (when create handlers are provided), then one section per category. `mode`
 * filters the list to inline-capable (`inline`) or offline-capable (`offline`)
 * entries; the surface-specific per-item control is injected via `renderControl`.
 */
export function EvaluatorCatalog({
	mode,
	items,
	loading,
	error,
	search,
	onSearchChange,
	renderControl,
	onCreateJudge,
	onCreateCode,
	onDeleteCustom,
	disabled,
	emptyLabel,
}: EvaluatorCatalogProps) {
	const visible = useMemo(() => {
		const filtered = items.filter((it) => {
			const capable = mode === "inline" ? it.capInline : it.capOffline;
			return capable && matchesSearch(it, search);
		});
		filtered.sort((a, b) => {
			const ra = CATEGORY_RANK[a.category] ?? 99;
			const rb = CATEGORY_RANK[b.category] ?? 99;
			if (ra !== rb) {
				return ra - rb;
			}
			return a.name.localeCompare(b.name);
		});
		return filtered;
	}, [items, mode, search]);

	const grouped = useMemo(() => {
		const map = new Map<string, EvaluatorCatalogItem[]>();
		for (const it of visible) {
			const arr = map.get(it.category) ?? [];
			arr.push(it);
			map.set(it.category, arr);
		}
		return CATEGORY_ORDER.filter((c) => map.has(c.key)).map((c) => ({
			label: c.label,
			key: c.key,
			rows: map.get(c.key) ?? [],
		}));
	}, [visible]);

	const canCreate = Boolean(onCreateJudge || onCreateCode);

	return (
		<div className="flex flex-col gap-3">
			<div className="relative">
				<HugeiconsIcon
					className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
					icon={Search01Icon}
				/>
				<Input
					className="h-8 pl-8 text-sm"
					onChange={(e) => onSearchChange(e.target.value)}
					placeholder="Search evaluators…"
					value={search}
				/>
			</div>

			{error ? <p className="text-destructive text-xs">{error}</p> : null}

			{canCreate ? (
				<div className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/20 p-3">
					<div className="flex items-center gap-1.5">
						<HugeiconsIcon
							className="size-3.5 text-muted-foreground"
							icon={ShieldIcon}
						/>
						<span className="font-medium text-sm">Create from scratch</span>
					</div>
					<p className="text-muted-foreground text-xs">
						Author your own evaluator. It joins the catalog and becomes runnable
						after the gateway restarts.
					</p>
					<div className="flex flex-wrap gap-2">
						{onCreateJudge ? (
							<Button
								disabled={disabled}
								onClick={onCreateJudge}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
								LLM-as-a-Judge
							</Button>
						) : null}
						{onCreateCode ? (
							<Button
								disabled={disabled}
								onClick={onCreateCode}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon className="size-3.5" icon={Add01Icon} />
								Code evaluator
							</Button>
						) : null}
					</div>
				</div>
			) : null}

			{loading ? (
				<div className="flex items-center gap-2 px-1 py-4 text-muted-foreground text-xs">
					<Spinner className="size-3" />
					Loading catalog…
				</div>
			) : null}

			{!loading && visible.length === 0 ? (
				<p className="px-1 py-4 text-muted-foreground text-xs">
					{emptyLabel ?? "No evaluators match."}
				</p>
			) : null}

			{grouped.map((section) => (
				<div className="flex flex-col gap-2" key={section.key}>
					<h4 className="px-0.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
						{section.label}
					</h4>
					<div className="flex flex-col gap-2">
						{section.rows.map((item) => (
							<EvaluatorRow
								control={renderControl?.(item)}
								deleteDisabled={disabled}
								item={item}
								key={item.id}
								mode={mode}
								onDelete={
									onDeleteCustom ? () => onDeleteCustom(item.id) : undefined
								}
							/>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
