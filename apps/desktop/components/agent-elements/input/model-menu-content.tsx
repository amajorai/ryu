"use client";

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { DropdownMenuItem } from "@ryu/ui/components/dropdown-menu.tsx";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/hover-card.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useEffect, useMemo, useState } from "react";
import { ItemTag } from "@/components/agent-elements/input/item-tag.tsx";
import {
	type ModelMenuOption,
	sortModelGroups,
} from "@/components/agent-elements/input/model-groups.ts";
import { ModelHoverPreview } from "@/components/agent-elements/input/model-hover-preview.tsx";
import { ModelUsageBadge } from "@/components/agent-elements/input/usage-bar.tsx";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	getModelInsight,
	type ModelInsight,
} from "@/src/lib/api/model-insight.ts";

interface InsightScope {
	id: number;
	target: ApiTarget;
}

let nextInsightScopeId = 0;

/** Short-lived cache so re-hovering is instant without pinning promotions forever. */
const INSIGHT_CACHE_TTL_MS = 15 * 60 * 1000;
const insightCache = new WeakMap<
	InsightScope,
	Map<string, { expiresAt: number; value: ModelInsight | null }>
>();
function cacheFor(scope: InsightScope) {
	let cache = insightCache.get(scope);
	if (!cache) {
		cache = new Map();
		insightCache.set(scope, cache);
	}
	return cache;
}

function cacheKey(modelId: string, provider: string | null): string {
	return `${provider ?? ""}::${modelId}`;
}

function providerFromModelId(modelId: string): string | null {
	const slash = modelId.indexOf("/");
	if (slash <= 0) {
		return null;
	}
	return modelId.slice(0, slash);
}

function ModelRow({
	model,
	isActive,
	onSelect,
	scope,
	usageAgentId,
	insightProvider,
}: {
	model: ModelMenuOption;
	isActive: boolean;
	onSelect: (modelId: string) => void;
	scope: InsightScope;
	/**
	 * The subscription agent these models belong to, when it has per-model quotas
	 * worth showing (Claude's weekly Sonnet/Opus limits, Codex's Spark). Null for
	 * Ryu's own Gateway-routed models, which have no vendor window.
	 */
	usageAgentId?: string | null;
	/** Provider registry to use for pricing when the model id is ambiguous. */
	insightProvider?: string | null;
}) {
	const [open, setOpen] = useState(false);
	const [insight, setInsight] = useState<ModelInsight | null>(null);
	const [loading, setLoading] = useState(false);

	const provider = insightProvider ?? providerFromModelId(model.id);

	useEffect(() => {
		if (!open) {
			return;
		}
		const cache = cacheFor(scope);
		const key = cacheKey(model.id, provider);
		const cached = cache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			setInsight(cached.value);
			setLoading(false);
			return;
		}
		cache.delete(key);
		let cancelled = false;
		setLoading(true);
		getModelInsight(scope.target, model.id, provider)
			.then((result) => {
				cache.set(key, {
					expiresAt: Date.now() + INSIGHT_CACHE_TTL_MS,
					value: result,
				});
				if (!cancelled) {
					setInsight(result);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [open, model.id, provider, scope]);

	const row = (
		<DropdownMenuItem
			closeOnClick={false}
			onClick={() => onSelect(model.id)}
			purpose="composer-model"
			selected={isActive}
		>
			<span className="flex w-full items-center gap-2.5">
				<span className="flex-1 truncate">{model.name}</span>
				{model.tag ? <ItemTag tag={model.tag} /> : null}
				{usageAgentId ? (
					<ModelUsageBadge
						agentId={usageAgentId}
						modelId={model.id}
						modelName={model.name}
					/>
				) : null}
				{isActive ? (
					<HugeiconsIcon
						className="shrink-0 text-muted-foreground"
						icon={Tick02Icon}
						size={16}
						strokeWidth={2}
					/>
				) : null}
			</span>
			{model.description ? (
				<span className="w-full truncate text-left font-normal text-muted-foreground text-xs">
					{model.description}
				</span>
			) : null}
		</DropdownMenuItem>
	);

	const showCard = open && (loading || insight !== null);

	return (
		<HoverCard onOpenChange={setOpen} open={open}>
			<HoverCardTrigger closeDelay={100} delay={350} render={row} />
			{showCard ? (
				<HoverCardContent
					align="start"
					className="z-[80] w-auto max-w-[18rem]"
					side="right"
					sideOffset={8}
					spacing="rail"
				>
					{insight ? (
						<ModelHoverPreview insight={insight} />
					) : (
						<div className="flex w-[16.5rem] flex-col gap-2">
							<div className="h-3.5 w-2/3 animate-skeleton rounded bg-muted-foreground/15" />
							<div className="grid grid-cols-2 gap-2">
								<div className="h-6 animate-skeleton rounded bg-muted-foreground/10" />
								<div className="h-6 animate-skeleton rounded bg-muted-foreground/10" />
								<div className="h-6 animate-skeleton rounded bg-muted-foreground/10" />
								<div className="h-6 animate-skeleton rounded bg-muted-foreground/10" />
							</div>
						</div>
					)}
				</HoverCardContent>
			) : null}
		</HoverCard>
	);
}

export function ModelMenuContent({
	models,
	activeId,
	onSelect,
	usageAgentId,
	insightProvider,
}: {
	models: ModelMenuOption[];
	activeId?: string;
	onSelect: (modelId: string) => void;
	/** See `ModelRow.usageAgentId`. */
	usageAgentId?: string | null;
	/** Provider registry to use for pricing when the model id is ambiguous. */
	insightProvider?: string | null;
}) {
	const node = useActiveNode();
	const scope = useMemo<InsightScope>(
		() => ({
			id: ++nextInsightScopeId,
			target: {
				url: node.url,
				token: node.token,
				userJwt: node.userJwt ?? null,
			},
		}),
		[node.url, node.token, node.userJwt]
	);
	const [query, setQuery] = useState("");
	const tl = useLiteralMessages();
	const normalizedQuery = query.trim().toLowerCase();

	const groups = useMemo(() => {
		const filtered = normalizedQuery
			? models.filter((model) => {
					const hay =
						`${model.name} ${model.id} ${model.description ?? ""} ${model.group ?? ""}`.toLowerCase();
					return hay.includes(normalizedQuery);
				})
			: models;

		const grouped: { label: string | null; items: ModelMenuOption[] }[] = [];
		for (const model of filtered) {
			const label = model.group ?? null;
			const existing = grouped.find((g) => g.label === label);
			if (existing) {
				existing.items.push(model);
			} else {
				grouped.push({ label, items: [model] });
			}
		}
		return sortModelGroups(grouped);
	}, [models, normalizedQuery]);

	const hasGroups = groups.some((g) => g.label !== null);

	const renderRow = (model: ModelMenuOption) => (
		<ModelRow
			insightProvider={insightProvider}
			isActive={model.id === activeId}
			key={`${scope.id}:${model.id}`}
			model={model}
			onSelect={onSelect}
			scope={scope}
			usageAgentId={usageAgentId}
		/>
	);

	return (
		<div className="flex max-h-80 flex-col">
			<div className="sticky top-0 z-10">
				<Input
					aria-label="Filter models"
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search models…"
					purpose="model-filter"
					value={query}
				/>
			</div>
			<div className="scroll-fade min-h-0 flex-1 overflow-y-auto p-1">
				{groups.length === 0 ? (
					<p className="px-3 py-4 text-center text-muted-foreground text-xs">
						{tl("No models match “{query}”", { query: query.trim() })}
					</p>
				) : null}
				{hasGroups
					? groups.map((group) => (
							<div key={group.label ?? "__ungrouped__"}>
								{group.label ? (
									<div className="type-caption px-3 pt-2 pb-1 font-medium text-muted-foreground">
										{group.label}
									</div>
								) : null}
								{group.items.map(renderRow)}
							</div>
						))
					: filteredFlat(groups).map(renderRow)}
			</div>
		</div>
	);
}

export function createModelMenuRenderer(
	models: ModelMenuOption[],
	activeId?: string,
	usageAgentId?: string | null,
	insightProvider?: string | null
) {
	return (onSelect: (id: string) => void) => (
		<ModelMenuContent
			activeId={activeId}
			insightProvider={insightProvider}
			models={models}
			onSelect={onSelect}
			usageAgentId={usageAgentId}
		/>
	);
}

function filteredFlat(
	groups: { label: string | null; items: ModelMenuOption[] }[]
): ModelMenuOption[] {
	return groups.flatMap((g) => g.items);
}
