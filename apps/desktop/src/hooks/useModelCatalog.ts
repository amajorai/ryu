// apps/desktop/src/hooks/useModelCatalog.ts
//
// Backs the Model Catalog page. Built on TanStack Query so the catalog feels
// instant: the list is cached per (query, sort, installed) key and the detail is
// cached per model id, so navigating back to a model you already opened needs no
// refetch. Install runs as a mutation with an optimistic cache update (the file
// flips to "Installed" immediately) and then revalidates both panes. Every data
// decision still lives in Core; this hook only holds query/selection UI state.

import {
	keepPreviousData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CatalogSource,
	fetchModelDetail,
	fetchModelSources,
	installModelFile,
	installModelSnapshot,
	MODEL_CATEGORY_TASK,
	type ModelCard,
	type ModelCategory,
	type ModelDetail,
	type ModelFormat,
	type ModelSort,
	searchModels,
	selectModelSource,
	uninstallModelFile,
} from "@/src/lib/api/models.ts";
import { useDebouncedValue } from "./use-debounced-value.ts";
import { useActiveNode } from "./useActiveNode.ts";

export interface UseModelCatalogResult {
	// Catalog sources
	/** Id of the active catalog source (Hugging Face by default). */
	activeSource: string;
	/** Browse one org/user as a clean catalog view. */
	browseOrg: (o: string) => void;
	// List
	category: ModelCategory;
	detail: ModelDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	/** Load the next page of results (infinite scroll). */
	fetchNextPage: () => void;
	/** Active weight-format facet. */
	format: ModelFormat;
	/** Whether more pages are available from the Hub. */
	hasNextPage: boolean;
	install: (file: string) => Promise<void>;
	installedOnly: boolean;
	// Mutations
	installing: string | null;
	/** Whether a snapshot install is currently in flight. */
	installingSnapshot: boolean;
	/** Install the selected model as a repo snapshot (safetensors / MLX). */
	installSnapshot: () => Promise<void>;
	loading: boolean;
	/** Whether the next page is currently loading. */
	loadingMore: boolean;
	models: ModelCard[];
	/** Active org/user "browse this org" filter (empty = none). */
	org: string;
	query: string;
	reload: () => Promise<void>;
	select: (id: string) => void;
	// Detail
	selectedId: string | null;
	/** Whether a source switch is in flight. */
	selectingSource: boolean;
	/** Switch the active catalog source, then refetch the model list. */
	selectSource: (id: string) => void;
	setCategory: (c: ModelCategory) => void;
	setFormat: (f: ModelFormat) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	setSort: (s: ModelSort) => void;
	sort: ModelSort;
	/** Every source available for the model kind. */
	sources: CatalogSource[];
	/** Remove an installed quantization; the filename currently being removed. */
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
}

const SEARCH_DEBOUNCE_MS = 300;

export function useModelCatalog(initialQuery = ""): UseModelCatalogResult {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
	};
	const { url, token } = target;
	const qc = useQueryClient();

	const [query, setQuery] = useState(initialQuery);
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [sort, setSort] = useState<ModelSort>("trending");
	const [category, setCategory] = useState<ModelCategory>("all");
	const [format, setFormat] = useState<ModelFormat>("gguf");
	const [installedOnly, setInstalledOnly] = useState(false);
	const [org, setOrg] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	// The format of the currently-selected card, so detail + install dispatch on
	// the model's own format (not whatever facet is now active).
	const [selectedFormat, setSelectedFormat] = useState<ModelFormat>("gguf");

	// Installed (local) models carry no Hugging Face task metadata, so a category
	// filter can't apply offline — ignore it in the installed-only view.
	const task = installedOnly ? "" : MODEL_CATEGORY_TASK[category];

	const listQuery = useInfiniteQuery({
		queryKey: [
			"models",
			"list",
			url,
			{ q: debouncedQuery, sort, format, installedOnly, task, org },
		],
		queryFn: ({ pageParam }) =>
			searchModels(
				{ url, token },
				{
					query: debouncedQuery,
					sort,
					format,
					installedOnly,
					task,
					org,
					limit: 40,
					cursor: pageParam,
				}
			),
		initialPageParam: undefined as string | undefined,
		// Stop once the Hub returns no further cursor.
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		// Keep the previous list on screen while the next one loads (no flash on
		// filter/sort changes) — pure-cache navigation feel.
		placeholderData: keepPreviousData,
	});

	// Flatten every loaded page into one list for the selector.
	const models = useMemo(
		() => listQuery.data?.pages.flatMap((p) => p.models) ?? [],
		[listQuery.data]
	);

	const detailQuery = useQuery({
		queryKey: ["models", "detail", url, selectedId, selectedFormat],
		queryFn: () =>
			fetchModelDetail({ url, token }, selectedId as string, selectedFormat),
		enabled: selectedId !== null,
	});

	const installMutation = useMutation({
		mutationFn: (file: string) =>
			installModelFile({ url, token }, selectedId as string, file),
		// Optimistically flip the file (and its card) to installed so the button
		// updates instantly; roll back if the download fails.
		onMutate: async (file: string) => {
			const key = ["models", "detail", url, selectedId, selectedFormat];
			await qc.cancelQueries({ queryKey: key });
			const previous = qc.getQueryData<ModelDetail>(key);
			if (previous) {
				qc.setQueryData<ModelDetail>(key, {
					...previous,
					card: { ...previous.card, installed: true },
					files: previous.files.map((f) =>
						f.filename === file ? { ...f, installed: true } : f
					),
				});
			}
			return { previous, key };
		},
		onError: (_err, _file, ctx) => {
			if (ctx?.previous) {
				qc.setQueryData(ctx.key, ctx.previous);
			}
		},
		onSettled: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "detail", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "list", url] })
			).catch(() => undefined);
		},
	});

	const uninstallMutation = useMutation({
		mutationFn: (file: string) =>
			uninstallModelFile({ url, token }, selectedId as string, file),
		// Optimistically flip the file back to not-installed so the button updates
		// instantly; roll back if the delete fails. The card's `installed` flag is
		// left for revalidation since other quants of the same repo may remain.
		onMutate: async (file: string) => {
			const key = ["models", "detail", url, selectedId, selectedFormat];
			await qc.cancelQueries({ queryKey: key });
			const previous = qc.getQueryData<ModelDetail>(key);
			if (previous) {
				const files = previous.files.map((f) =>
					f.filename === file ? { ...f, installed: false } : f
				);
				qc.setQueryData<ModelDetail>(key, {
					...previous,
					card: { ...previous.card, installed: files.some((f) => f.installed) },
					files,
				});
			}
			return { previous, key };
		},
		onError: (_err, _file, ctx) => {
			if (ctx?.previous) {
				qc.setQueryData(ctx.key, ctx.previous);
			}
		},
		onSettled: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "detail", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "list", url] })
			).catch(() => undefined);
		},
	});

	// Catalog sources: list + active selection live in Core. Selecting a source
	// switches Core's active endpoint, so every model list/detail must refetch.
	const sourcesQuery = useQuery({
		queryKey: ["models", "sources", url],
		queryFn: () => fetchModelSources({ url, token }),
	});

	const selectSourceMutation = useMutation({
		mutationFn: (id: string) => selectModelSource({ url, token }, id),
		onSuccess: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "sources", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "list", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "detail", url] })
			).catch(() => undefined);
		},
	});

	const selectSource = useCallback(
		(id: string) => {
			selectSourceMutation.mutate(id);
		},
		[selectSourceMutation]
	);

	const select = useCallback(
		(id: string) => {
			setSelectedId(id);
			// Remember the selected card's format so detail + install dispatch on
			// it; fall back to the active facet when the card isn't in the list.
			const card = models.find((m) => m.id === id);
			setSelectedFormat(card?.format ?? format);
		},
		[models, format]
	);

	const installSnapshotMutation = useMutation({
		mutationFn: () =>
			installModelSnapshot(
				{ url, token },
				selectedId as string,
				selectedFormat
			),
		onMutate: async () => {
			const key = ["models", "detail", url, selectedId, selectedFormat];
			await qc.cancelQueries({ queryKey: key });
			const previous = qc.getQueryData<ModelDetail>(key);
			if (previous) {
				qc.setQueryData<ModelDetail>(key, {
					...previous,
					card: { ...previous.card, installed: true },
				});
			}
			return { previous, key };
		},
		onError: (_err, _v, ctx) => {
			if (ctx?.previous) {
				qc.setQueryData(ctx.key, ctx.previous);
			}
		},
		onSettled: () => {
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "detail", url] })
			).catch(() => undefined);
			Promise.resolve(
				qc.invalidateQueries({ queryKey: ["models", "list", url] })
			).catch(() => undefined);
		},
	});

	const installSnapshot = useCallback(async () => {
		if (!selectedId) {
			return;
		}
		await installSnapshotMutation.mutateAsync();
	}, [selectedId, installSnapshotMutation]);

	const browseOrg = useCallback((o: string) => {
		setQuery("");
		setCategory("all");
		setInstalledOnly(false);
		setOrg(o);
	}, []);

	const reload = useCallback(async () => {
		await qc.invalidateQueries({ queryKey: ["models", "list", url] });
	}, [qc, url]);

	const install = useCallback(
		async (file: string) => {
			if (!selectedId) {
				return;
			}
			await installMutation.mutateAsync(file);
		},
		[selectedId, installMutation]
	);

	const uninstall = useCallback(
		async (file: string) => {
			if (!selectedId) {
				return;
			}
			await uninstallMutation.mutateAsync(file);
		},
		[selectedId, uninstallMutation]
	);

	return {
		models,
		loading: listQuery.isLoading,
		error: listQuery.error instanceof Error ? listQuery.error.message : null,
		fetchNextPage: listQuery.fetchNextPage,
		hasNextPage: listQuery.hasNextPage,
		loadingMore: listQuery.isFetchingNextPage,
		query,
		setQuery,
		sort,
		setSort,
		category,
		setCategory,
		installedOnly,
		setInstalledOnly,
		org,
		setOrg,
		browseOrg,
		reload,
		selectedId,
		select,
		detail: detailQuery.data ?? null,
		// isLoading is true only when there's no cached data yet — revisiting a
		// previously-opened model resolves from cache with no spinner.
		detailLoading: detailQuery.isLoading && selectedId !== null,
		detailError:
			detailQuery.error instanceof Error ? detailQuery.error.message : null,
		installing: installMutation.isPending
			? (installMutation.variables ?? null)
			: null,
		install,
		installSnapshot,
		installingSnapshot: installSnapshotMutation.isPending,
		format,
		setFormat,
		uninstall,
		uninstalling: uninstallMutation.isPending
			? (uninstallMutation.variables ?? null)
			: null,
		sources: sourcesQuery.data?.sources ?? [],
		activeSource: sourcesQuery.data?.active ?? "",
		selectSource,
		selectingSource: selectSourceMutation.isPending,
	};
}
