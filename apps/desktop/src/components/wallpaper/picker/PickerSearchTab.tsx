import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { useEffect, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type ImageHit,
	type ImageProvider,
	searchImages,
} from "@/src/lib/api/assets.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	type WallpaperPreference,
	wallpaperFullSizeUrl,
} from "@/src/lib/wallpaper.ts";
import { saveOrWarn, Thumb, Tile } from "./PickerGalleryTab.tsx";

export const SEARCH_SUGGESTIONS = [
	"Golden Gate",
	"Mountains",
	"Ocean",
	"Forest",
	"Gradient",
	"City night",
	"Desert",
	"Aurora",
] as const;

export const SEARCH_DEBOUNCE_MS = 350;
export const SEARCH_PAGE_SIZE = 24;

export function SearchTab({
	preference,
	update,
}: {
	preference: WallpaperPreference;
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const tl = useLiteralMessages();
	const node = useActiveNode();
	const [query, setQuery] = useState("Golden Gate");
	// Query and page change together so a new search never loads a stale page.
	const [request, setRequest] = useState({ page: 1, query });
	const { page, query: debouncedQuery } = request;
	const [results, setResults] = useState<ImageHit[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [provider, setProvider] = useState<ImageProvider>("unsplash");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const timeout = window.setTimeout(() => {
			const trimmed = query.trim();
			setRequest((current) =>
				current.query === trimmed ? current : { page: 1, query: trimmed }
			);
		}, SEARCH_DEBOUNCE_MS);
		return () => window.clearTimeout(timeout);
	}, [query]);

	useEffect(() => {
		if (page === 1) {
			setResults([]);
			setHasMore(false);
			setError(null);
		}
		if (!debouncedQuery) {
			return;
		}
		let cancelled = false;
		const load = async () => {
			setLoading(true);
			try {
				const target = toTarget(node);
				let response = await searchImages(
					target,
					"unsplash",
					debouncedQuery,
					SEARCH_PAGE_SIZE,
					page
				);
				if (!response.configured) {
					response = await searchImages(
						target,
						"openverse",
						debouncedQuery,
						SEARCH_PAGE_SIZE,
						page
					);
				}
				if (cancelled) {
					return;
				}
				setProvider(response.provider);
				setError(response.error ?? null);
				setHasMore(
					response.has_more ?? response.results.length >= SEARCH_PAGE_SIZE
				);
				setResults((current) => {
					const seen = new Set(current.map((hit) => hit.id));
					const fresh = response.results.filter((hit) => !seen.has(hit.id));
					return page === 1 ? response.results : [...current, ...fresh];
				});
			} catch (searchError) {
				if (!cancelled) {
					setHasMore(false);
					setError(
						searchError instanceof Error
							? searchError.message
							: "Search is unavailable right now."
					);
				}
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		};
		load().catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [debouncedQuery, node, page]);

	// Infinite scroll: load the next page when the sentinel under the grid
	// scrolls into view inside whichever dialog, popover or page hosts it.
	useEffect(() => {
		const sentinel = sentinelRef.current;
		if (!(sentinel && hasMore) || loading) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					setRequest((current) => ({ ...current, page: current.page + 1 }));
				}
			},
			{ rootMargin: "240px" }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, loading]);

	return (
		<div className="space-y-3">
			<div className="relative">
				<HugeiconsIcon
					className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
					icon={Search01Icon}
				/>
				<Input
					aria-label="Search images"
					leadingAdornment="default"
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search for an image…"
					value={query}
				/>
			</div>
			<div className="flex flex-wrap gap-1.5">
				{SEARCH_SUGGESTIONS.map((suggestion) => (
					<button
						className={cn(
							"h-8 rounded-lg px-3 text-sm transition-colors duration-(--duration-fast) hover:duration-0",
							query === suggestion
								? "bg-muted text-foreground"
								: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
						)}
						key={suggestion}
						onClick={() => setQuery(suggestion)}
						type="button"
					>
						{suggestion}
					</button>
				))}
			</div>
			{provider === "openverse" ? (
				<p className="text-muted-foreground text-xs">
					Showing Openverse results. Add an Unsplash access key to this node to
					search Unsplash.
				</p>
			) : null}
			{error ? (
				<p className="text-status-destructive text-xs">{error}</p>
			) : null}
			{!loading && results.length === 0 && debouncedQuery && !error ? (
				<p className="py-6 text-center text-muted-foreground text-sm">
					No images found.
				</p>
			) : null}
			<div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
				{results.map((hit) => {
					const url = wallpaperFullSizeUrl(hit.url);
					return (
						<Tile
							key={hit.id}
							label={`${hit.title || "Image"} · ${hit.attribution}`}
							onClick={() =>
								saveOrWarn(() =>
									update({
										image: {
											attribution: hit.attribution || null,
											label: hit.title || "Search result",
											sourceUrl: hit.source_url || null,
											url,
										},
										mode: "image",
									})
								)
							}
							selected={
								preference.mode === "image" && preference.image?.url === url
							}
						>
							<Thumb alt="" src={hit.preview_url} />
						</Tile>
					);
				})}
			</div>
			<div aria-hidden="true" className="h-px" ref={sentinelRef} />
			{loading ? (
				<div className="flex justify-center py-4">
					<Spinner className="size-5" />
				</div>
			) : null}
			{!(hasMore || loading) && results.length > 0 ? (
				<p className="py-2 text-center text-muted-foreground text-xs">
					{tl('That\'s everything for "{debouncedQuery}".', { debouncedQuery })}
				</p>
			) : null}
		</div>
	);
}
