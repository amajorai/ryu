// apps/desktop/src/hooks/useSkillsCatalog.ts
//
// Backs the Skills Catalog page. Same TanStack Query shape as the model catalog:
// the list is cached per (query, installed) key and the detail per skill id, so
// navigating back to a Skill you already opened is instant. Install runs as a
// mutation with an optimistic cache update. All data decisions live in Core.

import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type AddMarketplaceParams,
	addMarketplaceSource,
	fetchSkillDetail,
	fetchSkillSources,
	type InstalledSkill,
	installSkill,
	listSkills,
	type SkillCard,
	type SkillCatalogSource,
	type SkillDetail,
	searchSkills,
	selectSkillSource,
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
	/** Id of the active catalog source (skills.sh by default). */
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
	select: (id: string) => void;
	selectedId: string | null;
	/** Whether a source switch is in flight. */
	selectingSource: boolean;
	/** Switch the active source, then refetch the skills list. */
	selectSource: (id: string) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	/** Enable or disable an installed skill (global activation). */
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	setSort: (s: SkillSort) => void;
	skills: SkillCard[];
	sort: SkillSort;
	/** Every source available for the skill kind (skills.sh + marketplaces). */
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

export function useSkillsCatalog(initialQuery = ""): UseSkillsCatalogResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;
	const qc = useQueryClient();

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [installedOnly, setInstalledOnly] = useState(false);
	const [sort, setSort] = useState<SkillSort>("popular");
	const [org, setOrg] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
	const [togglingSkill, setTogglingSkill] = useState<string | null>(null);

	// Any change to the query/filter/sort/org starts the reveal window over.
	useEffect(() => {
		setVisibleCount(PAGE_SIZE);
	}, []);

	// Catalog sources: list + active selection live in Core. Selecting a source
	// or adding a marketplace re-keys the skills list against the new source.
	const sourcesQuery = useQuery({
		queryKey: ["skills", "sources", url],
		queryFn: () => fetchSkillSources({ url, token }),
	});
	const activeSource = sourcesQuery.data?.active ?? "";

	const selectSourceMutation = useMutation({
		mutationFn: (id: string) => selectSkillSource({ url, token }, id),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "sources", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["skills", "list", url] })
			).catch(() => undefined);
		},
	});
	const selectSource = useCallback(
		(id: string) => selectSourceMutation.mutate(id),
		[selectSourceMutation]
	);

	const addMarketplaceMutation = useMutation({
		mutationFn: (params: AddMarketplaceParams) =>
			addMarketplaceSource({ url, token }, params),
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

	const listQuery = useQuery({
		queryKey: [
			"skills",
			"list",
			url,
			{ q: debouncedQuery, installedOnly, source: activeSource },
		],
		queryFn: () =>
			searchSkills(
				{ url, token },
				{ query: debouncedQuery, installedOnly, limit: FETCH_LIMIT }
			),
		placeholderData: keepPreviousData,
	});

	const detailQuery = useQuery({
		queryKey: ["skills", "detail", url, selectedId],
		queryFn: () => fetchSkillDetail({ url, token }, selectedId as string),
		enabled: selectedId !== null,
	});

	const installMutation = useMutation({
		mutationFn: () => installSkill({ url, token }, selectedId as string),
		onMutate: async () => {
			const key = ["skills", "detail", url, selectedId];
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
		onSettled: () => {
			Promise.resolve(
				qc.invalidateQueries({
					queryKey: ["skills", "detail", url, selectedId],
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
	const installedQuery = useQuery({
		queryKey: ["skills", "installed", url],
		queryFn: () => listSkills({ url, token }),
	});

	const setActiveMutation = useMutation({
		mutationFn: (vars: { id: string; active: boolean }) =>
			setSkillActive({ url, token }, vars.id, vars.active),
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

	const select = useCallback((id: string) => setSelectedId(id), []);

	const install = useCallback(async () => {
		if (!selectedId) {
			return;
		}
		await installMutation.mutateAsync();
	}, [selectedId, installMutation]);

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
		sources: sourcesQuery.data?.sources ?? [],
		activeSource,
		selectSource,
		selectingSource: selectSourceMutation.isPending,
		addMarketplace,
		addingMarketplace: addMarketplaceMutation.isPending,
		installedSkills,
		enabledByKey,
		setSkillEnabled,
		togglingSkill,
	};
}
