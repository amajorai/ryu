// apps/desktop/src/components/assets/AssetPicker.tsx
//
// A shared asset-insertion dialog with three tabs — Icons (Iconify: Lucide +
// Hugeicons + 148 more sets), Logos (SVGL brand marks), and GIFs (Core proxy).
// Both the Spaces whiteboard and the creative canvas mount it and adapt the
// returned {@link AssetSelection} into their own element/node. Icons + logos need
// no configuration; GIFs need a free provider key on the node (the tab explains
// how when unconfigured).

import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog";
import { Input } from "@ryu/ui/components/input";
import { Spinner } from "@ryu/ui/components/spinner";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "@ryu/ui/components/tabs";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type AssetSelection,
	fetchIconSvg,
	fetchSvgText,
	type GifHit,
	type IconHit,
	type LogoHit,
	searchGifs,
	searchIcons,
	searchLogos,
} from "@/src/lib/api/assets.ts";
import { toTarget } from "@/src/lib/api/client.ts";

type AssetTab = "icons" | "logos" | "gifs";

const PLACEHOLDER: Record<AssetTab, string> = {
	icons: "Search icons (Lucide, Hugeicons, and more)…",
	logos: "Search brand logos…",
	gifs: "Search GIFs…",
};

export interface AssetPickerProps {
	onOpenChange: (open: boolean) => void;
	/** Called with the chosen asset. The host closes the dialog via onOpenChange. */
	onSelect: (selection: AssetSelection) => void;
	open: boolean;
}

/** A grid tile wrapping a preview image on a checkerboard-friendly surface. */
function Tile({
	label,
	onClick,
	children,
}: {
	label: string;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			aria-label={label}
			className="flex aspect-square items-center justify-center overflow-hidden rounded-lg border border-border bg-muted/30 p-2 transition-colors hover:border-primary hover:bg-muted"
			onClick={onClick}
			title={label}
			type="button"
		>
			{children}
		</button>
	);
}

function EmptyState({ message }: { message: string }) {
	return (
		<div className="flex h-40 items-center justify-center px-6 text-center text-muted-foreground text-sm">
			{message}
		</div>
	);
}

export function AssetPicker({
	open,
	onOpenChange,
	onSelect,
}: AssetPickerProps) {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);

	const [tab, setTab] = useState<AssetTab>("icons");
	const [query, setQuery] = useState("");
	const [debounced, setDebounced] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [icons, setIcons] = useState<IconHit[]>([]);
	const [logos, setLogos] = useState<LogoHit[]>([]);
	const [gifs, setGifs] = useState<GifHit[]>([]);
	const [gifConfigured, setGifConfigured] = useState(true);

	// Debounce the query so each keystroke doesn't fire a request.
	useEffect(() => {
		const t = setTimeout(() => setDebounced(query), 300);
		return () => clearTimeout(t);
	}, [query]);

	// Reset transient state when the dialog reopens.
	useEffect(() => {
		if (open) {
			setQuery("");
			setDebounced("");
			setError(null);
		}
	}, [open]);

	// Run the active tab's search whenever the tab or debounced query changes.
	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		const run = async () => {
			try {
				if (tab === "icons") {
					const hits = await searchIcons(debounced);
					if (!cancelled) {
						setIcons(hits);
					}
				} else if (tab === "logos") {
					const hits = await searchLogos(debounced);
					if (!cancelled) {
						setLogos(hits);
					}
				} else {
					const resp = await searchGifs(target, debounced);
					if (!cancelled) {
						setGifs(resp.results);
						setGifConfigured(resp.configured);
					}
				}
			} catch {
				if (!cancelled) {
					setError(
						"Couldn't load results. Check your connection and try again."
					);
				}
			} finally {
				if (!cancelled) {
					setLoading(false);
				}
			}
		};
		run();
		return () => {
			cancelled = true;
		};
	}, [open, tab, debounced, target]);

	const pickIcon = useCallback(
		async (hit: IconHit) => {
			try {
				const svg = await fetchIconSvg(hit.id);
				onSelect({ kind: "svg", svg, name: hit.id });
				onOpenChange(false);
			} catch {
				setError("Couldn't load that icon. Try another.");
			}
		},
		[onSelect, onOpenChange]
	);

	const pickLogo = useCallback(
		async (hit: LogoHit) => {
			try {
				const svg = await fetchSvgText(hit.svgUrl);
				onSelect({ kind: "svg", svg, name: hit.title });
				onOpenChange(false);
			} catch {
				setError("Couldn't load that logo. Try another.");
			}
		},
		[onSelect, onOpenChange]
	);

	const pickGif = useCallback(
		(hit: GifHit) => {
			onSelect({
				kind: "gif",
				url: hit.url,
				name: hit.title,
				width: hit.width,
				height: hit.height,
			});
			onOpenChange(false);
		},
		[onSelect, onOpenChange]
	);

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="flex h-[32rem] max-w-2xl flex-col">
				<DialogHeader>
					<DialogTitle>Insert asset</DialogTitle>
				</DialogHeader>
				<Tabs
					className="flex min-h-0 flex-1 flex-col"
					onValueChange={(v) => setTab(v as AssetTab)}
					value={tab}
				>
					<TabsList variant="pills">
						<TabsTrigger value="icons">Icons</TabsTrigger>
						<TabsTrigger value="logos">Logos</TabsTrigger>
						<TabsTrigger value="gifs">GIFs</TabsTrigger>
					</TabsList>
					<div className="relative mt-3">
						<Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							autoFocus
							className="pl-8"
							onChange={(e) => setQuery(e.target.value)}
							placeholder={PLACEHOLDER[tab]}
							value={query}
						/>
					</div>

					<div className="mt-3 min-h-0 flex-1 overflow-y-auto">
						{loading ? (
							<div className="flex h-40 items-center justify-center">
								<Spinner />
							</div>
						) : error ? (
							<EmptyState message={error} />
						) : (
							<>
								<TabsContent value="icons">
									{icons.length === 0 ? (
										<EmptyState message="No icons found. Try another search." />
									) : (
										<div className="grid grid-cols-8 gap-2">
											{icons.map((hit) => (
												<Tile
													key={hit.id}
													label={hit.id}
													onClick={() => pickIcon(hit)}
												>
													{/** biome-ignore lint/performance/noImgElement: remote SVG preview, not a bundled asset */}
													<img
														alt={hit.id}
														className="size-6"
														loading="lazy"
														src={hit.previewUrl}
													/>
												</Tile>
											))}
										</div>
									)}
								</TabsContent>
								<TabsContent value="logos">
									{logos.length === 0 ? (
										<EmptyState message="No logos found. Try another search." />
									) : (
										<div className="grid grid-cols-6 gap-2">
											{logos.map((hit) => (
												<Tile
													key={hit.svgUrl}
													label={hit.title}
													onClick={() => pickLogo(hit)}
												>
													{/** biome-ignore lint/performance/noImgElement: remote SVG preview, not a bundled asset */}
													<img
														alt={hit.title}
														className="size-10 object-contain"
														loading="lazy"
														src={hit.svgUrl}
													/>
												</Tile>
											))}
										</div>
									)}
								</TabsContent>
								<TabsContent value="gifs">
									{gifConfigured ? (
										gifs.length === 0 ? (
											<EmptyState message="No GIFs found. Try another search." />
										) : (
											<div className="grid grid-cols-4 gap-2">
												{gifs.map((hit) => (
													<button
														aria-label={hit.title}
														className="overflow-hidden rounded-lg border border-border transition-colors hover:border-primary"
														key={hit.id}
														onClick={() => pickGif(hit)}
														type="button"
													>
														{/** biome-ignore lint/performance/noImgElement: remote GIF preview, not a bundled asset */}
														<img
															alt={hit.title}
															className="aspect-square w-full object-cover"
															loading="lazy"
															src={hit.preview_url}
														/>
													</button>
												))}
											</div>
										)
									) : (
										<EmptyState message="GIF search needs a free API key (BYOK). Add your Klipy key on this node (Settings → set gif-api-key) to enable it. Icons and logos work with no setup." />
									)}
								</TabsContent>
							</>
						)}
					</div>
				</Tabs>
			</DialogContent>
		</Dialog>
	);
}
