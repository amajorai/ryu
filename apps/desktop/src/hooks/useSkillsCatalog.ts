// apps/desktop/src/hooks/useSkillsCatalog.ts
//
// Backs the Skills Catalog page. Same TanStack Query shape as the model catalog:
// the list is cached per (query, installed) key and the detail per skill id, so
// navigating back to a Skill you already opened is instant. Install runs as a
// mutation with an optimistic cache update. All data decisions live in Core.

import { ALL_SKILL_SOURCES_ID } from "@ryu/marketplace/catalog/types";
import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSkillDistributionFlow } from "@/src/components/skills/SkillDistributionProvider.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AddMarketplaceParams,
	addMarketplaceSource,
	fetchSkillDetail,
	fetchSkillSources,
	type InstalledSkill,
	listSkills,
	removeMarketplaceSource,
	reorderMarketplaceSource,
	type SkillCard,
	type SkillCatalogSource,
	type SkillDetail,
	searchSkills,
	setSkillActive,
} from "@/src/lib/api/skills.ts";
import { skillOrg } from "@/src/lib/catalog/friendly.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";

/**
 * Skills sort order. The skills.sh directory exposes no category/tag taxonomy
 * (only id/name/installs/source), so unlike the model catalog there is nothing
 * to filter by category on — the applicable control is sort. Applied
 * client-side over the already-fetched list since the install count is present.
 */
export type SkillSort = "popular" | "name";

export interface UseSkillsCatalogResult {
	/** Id of the per-view catalog source (`all` by default). */
	activeSource: string;
	/** Whether a marketplace add is in flight. */
	addingMarketplace: boolean;
	/** Add a custom Claude plugin marketplace as a skill source. */
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: SkillDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	/** Enabled (active) state keyed by skill id and slug, for quick lookup. */
	enabledByKey: Record<string, boolean>;
	error: string | null;
	/** Reveal the next window of skills (infinite scroll). */
	fetchNextPage: () => void;
	/** Whether more already-fetched skills remain to reveal. */
	hasNextPage: boolean;
	install: () => Promise<void>;
	installedOnly: boolean;
	/** Installed skills with their current enabled (active) state. */
	installedSkills: InstalledSkill[];
	installing: string | null;
	loading: boolean;
	/** Active org/owner "browse this org" filter (empty = none). */
	org: string;
	query: string;
	/** Remove a custom Claude plugin marketplace. */
	removeMarketplace: (id: string) => Promise<void>;
	/** Move a custom marketplace one position in the source list. */
	reorderMarketplace: (id: string, direction: "up" | "down") => Promise<void>;
	select: (id: string) => void;
	selectedId: string | null;
	/** Kept for the shared Store contract; source selection is local and instant. */
	selectingSource: boolean;
	/** Narrow the current view to one source, then refetch the skills list. */
	selectSource: (id: string) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	/** Enable or disable an installed skill (global activation). */
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	setSort: (s: SkillSort) => void;
	skills: SkillCard[];
	sort: SkillSort;
	/** Every source available for the skill kind (shown under All marketplaces). */
	sources: SkillCatalogSource[];
	/** Id of the skill whose enable/disable toggle is in flight, if any. */
	togglingSkill: string | null;
}

const SEARCH_DEBOUNCE_MS = 300;

/**
 * One generous batch is fetched from Core (skills.sh has no offset/cursor
 * pagination but returns large batches), then revealed `PAGE_SIZE` at a time as
 * the user scrolls. Sorting happens once over the full batch, so revealing more
 * never re-shuffles what's already on screen.
 */
const FETCH_LIMIT = 120;
const PAGE_SIZE = 40;

// ── Query descriptors ────────────────────────────────────────────────────────
//
// The hook AND the Store's warm-up path (`useStorePrefetch`) build their queries
// from these, so a prefetch can never land under a key no hook reads — which is
// the one failure mode of prefetching that looks like it worked and warms
// nothing. Anything in the key must be an ARGUMENT here, not read from a closure.

export function skillSourcesQuery(target: ApiTarget) {
	return {
		queryKey: ["skills", "sources", target.url],
		queryFn: () => fetchSkillSources(target),
	};
}

export function skillListQuery(
	target: ApiTarget,
	params: { installedOnly: boolean; query: string; source: string }
) {
	return {
		queryKey: [
			"skills",
			"list",
			target.url,
			{
				q: params.query,
				installedOnly: params.installedOnly,
				source: params.source,
			},
		],
		queryFn: () =>
			searchSkills(target, {
				query: params.query,
				installedOnly: params.installedOnly,
				limit: FETCH_LIMIT,
				source: params.source,
			}),
	};
}

export function installedSkillsQuery(target: ApiTarget) {
	return {
		queryKey: ["skills", "installed", target.url],
		queryFn: () => listSkills(target),
	};
}

export function useSkillsCatalog(initialQuery = ""): UseSkillsCatalogResult {
	const { installCatalogSkill } = useSkillDistributionFlow();
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const { url, token, userJwt } = target;
	const qc = useQueryClient();

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [installedOnly, setInstalledOnly] = useState(false);
	const [sort, setSort] = useState<SkillSort>("popular");
	const [org, setOrg] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedSource, setSelectedSource] = useState<string | null>(null);
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const [togglingSkill, setTogglingSkill] = useState<string | null>(null);

	// Any change to the query/filter/sort/org starts the reveal window over.
	// These four deps ARE that sentence: without them the reset only runs at
	// mount, so a new search inherits the previous search's expanded window.
	useEffect(() => {
		setVisibleCount(PAGE_SIZE);
	}, [debouncedQuery, installedOnly, sort, org]);

	// Catalog sources are listed by Core, while the selected view is local to this
	// Store instance. This mirrors the Apps catalog: two open clients cannot
	// re-point one another by writing a node-global preference, and the default is
	// the live federated `all` view.
	const sourcesQuery = useQuery(skillSourcesQuery(target));
	const sources = sourcesQuery.data?.sources ?? [];
	const [sourceOverride, setSourceOverride] = useState<string | null>(null);
	const activeSource = sourceOverride ?? ALL_SKILL_SOURCES_ID;
	const selectSource = useCallback((id: string) => {
		if (!id) {
			return;
		}
		setSourceOverride(id);
		setSelectedId(null);
		setSelectedSource(null);
	}, []);

	const addMarketplaceMutation = useMutation({
		mutationFn: (params: AddMarketplaceParams) =>
			addMarketplaceSource({ url, token, userJwt }, params),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "sources", url] })
			).catch(() => undefined);
		},
	});
	const addMarketplace = useCallback(
		(params: AddMarketplaceParams) =>
			addMarketplaceMutation.mutateAsync(params),
		[addMarketplaceMutation]
	);

	const removeMarketplaceMutation = useMutation({
		mutationFn: (id: string) =>
			removeMarketplaceSource({ url, token, userJwt }, id),
		onSuccess: (_data, id) => {
			if (sourceOverride === id) {
				setSourceOverride(null);
			}
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "sources", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "list", url] })
			).catch(() => undefined);
		},
	});
	const removeMarketplace = useCallback(
		(id: string) => removeMarketplaceMutation.mutateAsync(id),
		[removeMarketplaceMutation]
	);

	const reorderMarketplaceMutation = useMutation({
		mutationFn: ({ id, direction }: { id: string; direction: "up" | "down" }) =>
			reorderMarketplaceSource({ url, token, userJwt }, id, direction),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "sources", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "list", url] })
			).catch(() => undefined);
		},
	});
	const reorderMarketplace = useCallback(
		(id: string, direction: "up" | "down") =>
			reorderMarketplaceMutation.mutateAsync({ id, direction }),
		[reorderMarketplaceMutation]
	);

	const listQuery = useQuery({
		...skillListQuery(target, {
			query: debouncedQuery,
			installedOnly,
			source: activeSource,
		}),
		placeholderData: keepPreviousData,
	});

	const detailSource = selectedSource ?? activeSource;
	const detailQuery = useQuery({
		queryKey: ["skills", "detail", url, selectedId, detailSource],
		queryFn: () =>
			fetchSkillDetail(
				{ url, token, userJwt },
				selectedId as string,
				detailSource === ALL_SKILL_SOURCES_ID ? undefined : detailSource
			),
		enabled: selectedId !== null,
	});

	const installMutation = useMutation({
		mutationFn: (vars: { id: string; source?: string }) =>
			installCatalogSkill(vars),
		onMutate: async (vars) => {
			const key = ["skills", "detail", url, vars.id, detailSource];
			await qc.cancelQueries({ queryKey: key });
			const previous = qc.getQueryData<SkillDetail>(key);
			if (previous) {
				qc.setQueryData<SkillDetail>(key, {
					...previous,
					card: { ...previous.card, installed: true },
				});
			}
			return { previous, key };
		},
		onError: (_err, _vars, ctx) => {
			if (ctx?.previous) {
				qc.setQueryData(ctx.key, ctx.previous);
			}
		},
		onSuccess: (result, _vars, ctx) => {
			if (result === null && ctx?.previous) {
				qc.setQueryData(ctx.key, ctx.previous);
			}
		},
		onSettled: (_data, _error, vars) => {
			Promise.resolve(
				qc.invalidateQueries({
					queryKey: ["skills", "detail", url, vars.id, detailSource],
				})
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "list", url] })
			).catch(() => undefined);
		},
	});

	// Installed skills + their enabled (active) state. Distinct from the catalog
	// list (which is the browsable directory): this reflects what's on disk and
	// whether each skill is active. Drives the enable/disable toggle.
	const installedQuery = useQuery(installedSkillsQuery(target));

	const setActiveMutation = useMutation({
		mutationFn: (vars: { id: string; active: boolean }) =>
			setSkillActive({ url, token, userJwt }, vars.id, vars.active),
		onMutate: (vars) => {
			setTogglingSkill(vars.id);
		},
		onSettled: () => {
			setTogglingSkill(null);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "installed", url] })
			).catch(() => undefined);
		},
	});
	const setSkillEnabled = useCallback(
		(id: string, active: boolean) =>
			setActiveMutation.mutateAsync({ id, active }),
		[setActiveMutation]
	);

	const installedSkills = useMemo(
		() => installedQuery.data ?? [],
		[installedQuery.data]
	);
	const enabledByKey = useMemo(() => {
		const map: Record<string, boolean> = {};
		for (const s of installedSkills) {
			map[s.id] = s.enabled;
		}
		return map;
	}, [installedSkills]);

	// Sort client-side over the FULL fetched batch: install counts are already on
	// each card, so re-ordering needs no refetch (and keeps the same cached list
	// across sort changes). Sorting the whole batch once — before windowing —
	// means revealing more never re-shuffles what's already visible.
	const sortedSkills = useMemo(() => {
		const list = listQuery.data ?? [];
		// Org "browse this org" filter — applied over the full pool before
		// windowing so paging never reveals out-of-org skills.
		const filtered = org ? list.filter((s) => skillOrg(s) === org) : list;
		const sorted = [...filtered];
		if (sort === "name") {
			sorted.sort((a, b) =>
				a.name.toLowerCase().localeCompare(b.name.toLowerCase())
			);
		} else {
			sorted.sort((a, b) => b.installs - a.installs);
		}
		return sorted;
	}, [listQuery.data, sort, org]);

	// Only reveal the first `visibleCount` of the sorted batch (infinite scroll).
	const skills = useMemo(
		() => sortedSkills.slice(0, visibleCount),
		[sortedSkills, visibleCount]
	);
	const hasNextPage = visibleCount < sortedSkills.length;
	const fetchNextPage = useCallback(
		() => setVisibleCount((c) => c + PAGE_SIZE),
		[]
	);

	// An empty id means "nothing selected" — the store sections close a preview by
	// calling `select("")`. Storing that verbatim left a selection that is neither
	// null nor resolvable: the detail query fired for the empty id, and any
	// `selectedId != null` test upstream read the closed preview as open.
	const select = useCallback(
		(id: string) => {
			if (!id) {
				setSelectedId(null);
				setSelectedSource(null);
				return;
			}
			const card = skills.find((item) => item.id === id);
			setSelectedSource(card?.catalogSourceId ?? activeSource);
			setSelectedId(id);
		},
		[activeSource, skills]
	);

	const install = useCallback(async () => {
		if (!selectedId) {
			return;
		}
		const source =
			detailSource === ALL_SKILL_SOURCES_ID ? undefined : detailSource;
		await installMutation.mutateAsync({ id: selectedId, source });
	}, [detailSource, installMutation, selectedId]);

	return {
		skills,
		hasNextPage,
		fetchNextPage,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		query,
		setQuery,
		sort,
		setSort,
		installedOnly,
		setInstalledOnly,
		org,
		setOrg,
		selectedId,
		select,
		detail: detailQuery.data ?? null,
		detailLoading: detailQuery.isLoading && selectedId !== null,
		detailError:
			detailQuery.error instanceof Error ? detailQuery.error.message : null,
		installing: installMutation.isPending ? selectedId : null,
		install,
		sources,
		activeSource,
		selectSource,
		selectingSource: false,
		addMarketplace,
		addingMarketplace: addMarketplaceMutation.isPending,
		removeMarketplace,
		reorderMarketplace,
		installedSkills,
		enabledByKey,
		setSkillEnabled,
		togglingSkill,
	};
}
