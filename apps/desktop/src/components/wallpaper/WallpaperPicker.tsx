// apps/desktop/src/components/wallpaper/WallpaperPicker.tsx
//
// Notion-style wallpaper chooser used by Settings → Appearance, the OS
// "Customize desktop" dialog and the startup chooser. Five tabs:
// - Gallery  → curated Unsplash sets plus a "Shuffle" tile for random mode.
// - Animated → the universal backdrop registry (shaders, canvas, patterns)
//              with generated customization controls.
// - Unsplash → live, infinitely scrolling search through the node's
//              `/api/assets/images/search` proxy. Without a node Unsplash key
//              it falls back to Openverse.
// - Upload   → a local image, downscaled and stored on this device.
// - Link     → any https image URL.

import { Backdrop } from "@ryu/ui/components/backdrop/backdrop.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Check, ImageUp, Link2, Search, Shuffle } from "lucide-react";
import { type SubmitEvent, useEffect, useId, useRef, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type ImageHit,
	type ImageProvider,
	searchImages,
} from "@/src/lib/api/assets.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import {
	ALL_WALLPAPER_SETS,
	fileToWallpaperDataUrl,
	type OsWallpaper,
	useWallpaper,
	WALLPAPER_SETS,
	type WallpaperPreference,
	wallpaperFullSizeUrl,
	wallpapersInSet,
	wallpaperThumbnailUrl,
} from "@/src/lib/wallpaper.ts";
import { BackdropTab } from "./BackdropTab.tsx";

const SEARCH_SUGGESTIONS = [
	"Golden Gate",
	"Mountains",
	"Ocean",
	"Forest",
	"Gradient",
	"City night",
	"Desert",
	"Aurora",
] as const;

const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_PAGE_SIZE = 24;

function Tile({
	children,
	className,
	label,
	onClick,
	selected,
}: {
	children: React.ReactNode;
	className?: string;
	label: string;
	onClick: () => void;
	selected: boolean;
}) {
	return (
		<button
			aria-label={label}
			aria-pressed={selected}
			className={cn(
				"group relative aspect-[16/10] overflow-hidden rounded-xl bg-muted outline-none ring-offset-2 ring-offset-background transition focus-visible:ring-2 focus-visible:ring-ring",
				selected && "ring-2 ring-primary",
				className
			)}
			onClick={onClick}
			title={label}
			type="button"
		>
			{children}
			{selected ? (
				<span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
					<Check className="size-3" />
				</span>
			) : null}
		</button>
	);
}

function Thumb({ alt, src }: { alt: string; src: string }) {
	return (
		<img
			alt={alt}
			className="size-full object-cover transition-transform duration-300 group-hover:scale-105 motion-reduce:transition-none"
			decoding="async"
			loading="lazy"
			src={src}
		/>
	);
}

function saveOrWarn(apply: () => void): boolean {
	try {
		apply();
		return true;
	} catch (error) {
		toast.error({
			title: "Couldn't save wallpaper",
			description:
				error instanceof DOMException && error.name === "QuotaExceededError"
					? "That image is too large to keep on this device. Try a smaller one."
					: "Please try again.",
		});
		return false;
	}
}

function GalleryTab({
	preference,
	update,
}: {
	preference: WallpaperPreference;
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const randomSelected = preference.mode === "random";
	const sets = [ALL_WALLPAPER_SETS, ...WALLPAPER_SETS];
	return (
		<div className="space-y-4">
			<div>
				<p className="mb-2 font-medium text-muted-foreground text-xs">
					Shuffle a new wallpaper every launch
				</p>
				<div className="flex flex-wrap gap-1.5">
					{sets.map((set) => {
						const active = randomSelected && preference.set === set;
						return (
							<button
								aria-pressed={active}
								className={cn(
									"inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
									active
										? "border-primary bg-primary text-primary-foreground"
										: "border-border bg-background hover:bg-muted"
								)}
								key={set}
								onClick={() => update({ mode: "random", set })}
								type="button"
							>
								{set === ALL_WALLPAPER_SETS ? (
									<Shuffle className="size-3" />
								) : null}
								{set === ALL_WALLPAPER_SETS ? "All wallpapers" : set}
							</button>
						);
					})}
				</div>
			</div>
			{WALLPAPER_SETS.map((set) => (
				<section key={set}>
					<h4 className="mb-2 font-medium text-muted-foreground text-xs">
						{set}
					</h4>
					<div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
						{wallpapersInSet(set).map((item: OsWallpaper) => (
							<Tile
								key={item.id}
								label={item.label}
								onClick={() =>
									update({ mode: "preset", presetId: item.id, set })
								}
								selected={
									preference.mode === "preset" &&
									preference.presetId === item.id
								}
							>
								<Thumb alt="" src={wallpaperThumbnailUrl(item.url)} />
							</Tile>
						))}
					</div>
				</section>
			))}
		</div>
	);
}

function SearchTab({
	preference,
	update,
}: {
	preference: WallpaperPreference;
	update: (next: Partial<WallpaperPreference>) => void;
}) {
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
				<Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
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
							"rounded-full border px-2.5 py-1 text-xs transition-colors",
							query === suggestion
								? "border-primary bg-primary text-primary-foreground"
								: "border-border bg-background hover:bg-muted"
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
			{error ? <p className="text-destructive text-xs">{error}</p> : null}
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
							<span
								className="type-compact absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pt-3 pb-1 text-left text-white opacity-0 transition-opacity group-hover:opacity-100"
								title={hit.attribution}
							>
								{hit.attribution}
							</span>
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
					That's everything for "{debouncedQuery}".
				</p>
			) : null}
		</div>
	);
}

function UploadTab({
	update,
}: {
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [dragging, setDragging] = useState(false);

	const applyFile = async (file: File | undefined) => {
		if (!file || busy) {
			return;
		}
		setBusy(true);
		try {
			const url = await fileToWallpaperDataUrl(file);
			saveOrWarn(() =>
				update({
					image: { attribution: null, label: file.name, sourceUrl: null, url },
					mode: "image",
				})
			);
		} catch (error) {
			toast.error({
				title: "Couldn't use that image",
				description:
					error instanceof Error ? error.message : "Please try another file.",
			});
		} finally {
			setBusy(false);
			if (inputRef.current) {
				inputRef.current.value = "";
			}
		}
	};

	return (
		<label
			className={cn(
				"flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-10 text-center transition-colors",
				dragging
					? "border-primary bg-primary/5"
					: "border-border hover:bg-muted/50"
			)}
			htmlFor={inputId}
			onDragLeave={() => setDragging(false)}
			onDragOver={(event) => {
				event.preventDefault();
				setDragging(true);
			}}
			onDrop={(event) => {
				event.preventDefault();
				setDragging(false);
				applyFile(event.dataTransfer.files[0]).catch(() => undefined);
			}}
		>
			{busy ? (
				<Spinner className="size-6" />
			) : (
				<ImageUp className="size-6 text-muted-foreground" />
			)}
			<span className="font-medium text-sm">Upload an image</span>
			<span className="text-muted-foreground text-xs">
				Drop a photo here or click to browse. It stays on this device.
			</span>
			<input
				accept="image/*"
				className="sr-only"
				id={inputId}
				onChange={(event) => {
					applyFile(event.target.files?.[0]).catch(() => undefined);
				}}
				ref={inputRef}
				type="file"
			/>
		</label>
	);
}

function isAllowedImageUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:";
	} catch {
		return false;
	}
}

function LinkTab({
	update,
}: {
	update: (next: Partial<WallpaperPreference>) => void;
}) {
	const [value, setValue] = useState("");
	const valid = isAllowedImageUrl(value.trim());
	const submit = (event: SubmitEvent) => {
		event.preventDefault();
		const url = value.trim();
		if (!isAllowedImageUrl(url)) {
			return;
		}
		const saved = saveOrWarn(() =>
			update({
				image: {
					attribution: null,
					label: new URL(url).hostname,
					sourceUrl: url,
					url,
				},
				mode: "image",
			})
		);
		if (saved) {
			setValue("");
		}
	};
	return (
		<form className="space-y-3" onSubmit={submit}>
			<div className="relative">
				<Link2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					aria-label="Image link"
					leadingAdornment="default"
					onChange={(event) => setValue(event.target.value)}
					placeholder="Paste an https:// image link…"
					value={value}
				/>
			</div>
			<Button className="w-full" disabled={!valid} type="submit">
				Use this image
			</Button>
			<p className="text-muted-foreground text-xs">
				Works with any image on the web, including Unsplash photo links.
			</p>
		</form>
	);
}

/** Current wallpaper preview with shuffle and credit. */
export function WallpaperPreview() {
	const { preference, shuffle, wallpaper } = useWallpaper();
	return (
		<div className="flex items-center gap-3">
			<div className="relative aspect-[16/10] w-28 shrink-0 overflow-hidden rounded-lg bg-muted">
				{wallpaper.backdrop ? (
					<Backdrop
						id={wallpaper.backdrop.id}
						params={wallpaper.backdrop.params}
						posterOnly
					/>
				) : (
					<img
						alt=""
						className="size-full object-cover"
						src={wallpaperThumbnailUrl(wallpaper.url)}
					/>
				)}
			</div>
			<div className="min-w-0 flex-1">
				<p className="truncate font-medium text-sm" title={wallpaper.label}>
					{wallpaper.label}
				</p>
				<p className="truncate text-muted-foreground text-xs">
					{preference.mode === "random"
						? `Shuffles each launch · ${preference.set === ALL_WALLPAPER_SETS ? "All wallpapers" : preference.set}`
						: (wallpaper.attribution ?? wallpaper.set)}
				</p>
			</div>
			<Button onClick={shuffle} size="sm" variant="outline">
				<Shuffle className="size-3.5" />
				Shuffle
			</Button>
		</div>
	);
}

export function WallpaperPicker({ className }: { className?: string }) {
	const { preference, update } = useWallpaper();
	return (
		<Tabs className={className} defaultValue="gallery">
			<div className="flex flex-col gap-3">
				<TabsList className="w-full justify-start" variant="text">
					<TabsTrigger value="gallery">Gallery</TabsTrigger>
					<TabsTrigger value="animated">Animated</TabsTrigger>
					<TabsTrigger value="unsplash">Unsplash</TabsTrigger>
					<TabsTrigger value="upload">Upload</TabsTrigger>
					<TabsTrigger value="link">Link</TabsTrigger>
				</TabsList>
				<TabsContent value="gallery">
					<GalleryTab preference={preference} update={update} />
				</TabsContent>
				<TabsContent value="animated">
					<BackdropTab preference={preference} update={update} />
				</TabsContent>
				<TabsContent value="unsplash">
					<SearchTab preference={preference} update={update} />
				</TabsContent>
				<TabsContent value="upload">
					<UploadTab update={update} />
				</TabsContent>
				<TabsContent value="link">
					<LinkTab update={update} />
				</TabsContent>
			</div>
		</Tabs>
	);
}
