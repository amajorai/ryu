import {
	Chat01Icon,
	DeliverySecure01Icon,
	Package01Icon,
	PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import type { AttachedImage } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import type { CommandPaletteTab } from "@ryu/command/types";
import { useHotkey } from "@ryu/hotkeys/react";
import { toast } from "@ryu/ui/components/sileo.tsx";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useCompanionAlias } from "@/src/contributions/use-companion-alias.ts";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import type { useCommandSearchSections } from "@/src/hooks/useCommandSearchSections.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type MessageSearchHit,
	searchConversations,
} from "@/src/lib/api/conversation-search.ts";
import {
	type MarketplaceCard,
	searchMarketplaceCatalog,
} from "@/src/lib/api/marketplace.ts";
import { type ShadowSearchResult, searchShadow } from "@/src/lib/api/shadow.ts";
import {
	type SpaceLexicalHit,
	searchSpaceDocuments,
} from "@/src/lib/api/spaces.ts";
import { stageImageUpload } from "@/src/lib/api/uploads.ts";
import { listenWhenReady } from "@/src/lib/tauri-ready.ts";
import type { OpenTab, PluginContributions } from "./palette-constants.ts";

/** The palette's debounced search lanes: captured context, messages, pages and
 *  the Marketplace catalog. */
export function usePaletteSearch(
	query: string,
	target: ApiTarget,
	isCurrentTarget: () => boolean
) {
	const [shadowResults, setShadowResults] = useState<ShadowSearchResult[]>([]);
	const [messageResults, setMessageResults] = useState<MessageSearchHit[]>([]);
	const [spaceResults, setSpaceResults] = useState<SpaceLexicalHit[]>([]);
	const [marketplaceResults, setMarketplaceResults] = useState<
		MarketplaceCard[]
	>([]);
	const searchAbort = useRef<AbortController | null>(null);
	const messageAbort = useRef<AbortController | null>(null);
	const spaceAbort = useRef<AbortController | null>(null);
	const marketplaceAbort = useRef<AbortController | null>(null);

	// Debounced "search everything" against Shadow's captured context (window
	// titles, clipboard, files, git, terminal, OCR). Resolves to [] when Shadow
	// is not running so the palette still works as a plain command launcher.
	useEffect(() => {
		const q = query.trim();
		searchAbort.current?.abort();
		if (q.length < 2) {
			setShadowResults([]);
			return;
		}
		const controller = new AbortController();
		searchAbort.current = controller;
		const handle = setTimeout(async () => {
			const results = await searchShadow(q, 8, controller.signal);
			if (results && !controller.signal.aborted) {
				setShadowResults(results);
			}
		}, 200);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query]);

	// Debounced exact + semantic search over past chat messages. Core puts lexical
	// FTS hits first and semantic hits after them, so literal recall stays
	// predictable without losing meaning-based matches when embeddings exist.
	// `target` is a fresh object every render; depending on its primitive fields avoids an infinite update loop (see comment on the deps array below).
	useEffect(() => {
		const q = query.trim();
		messageAbort.current?.abort();
		if (q.length < 2) {
			setMessageResults([]);
			return;
		}
		setMessageResults([]);
		const controller = new AbortController();
		messageAbort.current = controller;
		const handle = setTimeout(async () => {
			const result = await searchConversations(target, q, 8, controller.signal);
			if (result && !controller.signal.aborted && isCurrentTarget()) {
				setMessageResults(result.hits);
			}
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
		// Primitive deps only — `target` is a fresh object every render, so listing
		// it would re-run this effect each render and the early `setMessageResults([])`
		// (a fresh array, never bailed) would spin into an infinite update loop.
	}, [query, target.url, target.token, target.userJwt]);

	// Page/Space lexical search is separate from per-Space RAG search: the palette
	// needs predictable literal recall over visible metadata, page source, and
	// extracted chunks, even when no embedding model is available.
	// `target` is a fresh object every render; primitive fields are the stable request identity.
	useEffect(() => {
		const q = query.trim();
		spaceAbort.current?.abort();
		if (q.length < 2) {
			setSpaceResults([]);
			return;
		}
		setSpaceResults([]);
		const controller = new AbortController();
		spaceAbort.current = controller;
		const handle = setTimeout(async () => {
			const results = await searchSpaceDocuments(
				target,
				q,
				8,
				controller.signal
			);
			if (results && !controller.signal.aborted && isCurrentTarget()) {
				setSpaceResults(results);
			}
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query, target.url, target.token, target.userJwt]);

	// The control-plane Marketplace is a separate public catalog from the
	// node-scoped Store feed. Search it only after the user has typed a real query,
	// and keep failures isolated so an unavailable Marketplace never breaks local
	// commands, messages, pages, or captured context.
	useEffect(() => {
		const q = query.trim();
		marketplaceAbort.current?.abort();
		if (q.length < 2) {
			setMarketplaceResults([]);
			return;
		}
		setMarketplaceResults([]);
		const controller = new AbortController();
		marketplaceAbort.current = controller;
		const handle = setTimeout(() => {
			searchMarketplaceCatalog(q, 8, controller.signal)
				.then((results) => {
					if (!controller.signal.aborted) {
						setMarketplaceResults(results);
					}
				})
				.catch(() => {
					// Marketplace search is an optional palette lane.
				});
		}, 250);
		return () => {
			clearTimeout(handle);
			controller.abort();
		};
	}, [query]);

	return {
		marketplaceResults,
		messageResults,
		setMarketplaceResults,
		setMessageResults,
		setShadowResults,
		setSpaceResults,
		shadowResults,
		spaceResults,
	};
}

/** The palette hotkey, the open-palette window event and the tray quick actions. */
export function usePaletteOpenTriggers(
	setOpen: (open: boolean | ((previous: boolean) => boolean)) => void,
	openTab: OpenTab
) {
	// The palette toggle routes through the unified hotkey system so a rebind in
	// Settings → Keyboard Shortcuts retargets it live. The custom event stays for
	// the titlebar search button and tray actions that open the palette directly.
	useHotkey("command-palette.toggle", () => setOpen((prev) => !prev));

	useEffect(() => {
		const handleOpenEvent = () => setOpen(true);
		window.addEventListener("ryu:open-command-palette", handleOpenEvent);
		return () => {
			window.removeEventListener("ryu:open-command-palette", handleOpenEvent);
		};
	}, []);

	// Tray quick actions (Rust emits these from src-tauri/src/tray.rs).
	//
	// `/timeline` is an app-owned path resolved through the companion-alias
	// catch-all, and the owning app is not pre-installed — so the tray item is gated on
	// the same live feed the route mounts from, and does nothing when no enabled
	// app claims it rather than opening an "App not enabled" tab. Same AFFORDANCE
	// rule the `nav.timeline` hotkey in `Layout.tsx` already follows.
	const timelineCompanion = useCompanionAlias("/timeline");
	useEffect(() => {
		// Routed through the ready-gate. This effect runs on the first render of the
		// shell, which on a cold start can beat Tauri's injection of
		// `window.__TAURI_INTERNALS__` — and a bare `listen()` then rejects reaching
		// for `transformCallback`, which is the most frequent production signature
		// (RUST-C, 66 events). The gate queues the subscribe until the bridge lands
		// and degrades to a no-op unlisten when there is no bridge at all.
		//
		// The `.catch` is attached at subscribe time, NOT only in the cleanup: the
		// palette stays mounted for the whole session, so its cleanup never runs on
		// the boot path, and a rejection parked on an un-terminated promise fires
		// `unhandledrejection` at the window before any later `.catch` could adopt it.
		let disposed = false;
		const unlisteners: UnlistenFn[] = [];
		const track = (unlisten: UnlistenFn) => {
			// Unmounted while the subscribe was still in flight — drop it immediately
			// rather than leaking a listener with no owner.
			if (disposed) {
				unlisten();
				return;
			}
			unlisteners.push(unlisten);
		};
		const ignore = <TError>(error: TError) => {
			console.error("tray event subscription failed", error);
		};
		listenWhenReady("tray-open-timeline", () => {
			if (timelineCompanion) {
				openTab("/timeline");
			}
		})
			.then(track)
			.catch(ignore);
		listenWhenReady("tray-open-palette", () => setOpen(true))
			.then(track)
			.catch(ignore);
		return () => {
			disposed = true;
			for (const unlisten of unlisteners) {
				unlisten();
			}
		};
		// `timelineCompanion` is a plain string|null, so this only re-subscribes
		// when the owning app is actually enabled or disabled.
	}, [openTab, timelineCompanion]);
}

/** The active node as an API target, plus a generation guard that drops async results once the target changes or the palette unmounts. */
export function usePaletteTarget() {
	const activeNode = useActiveNode();
	const target: ApiTarget = {
		url: activeNode.url,
		token: activeNode.token ?? null,
		userJwt: activeNode.userJwt ?? null,
	};
	const targetScope = JSON.stringify([
		target.url,
		target.token,
		target.userJwt,
	]);
	const currentTargetScope = useRef({ scope: targetScope, generation: 0 });
	if (currentTargetScope.current.scope !== targetScope) {
		currentTargetScope.current = {
			scope: targetScope,
			generation: currentTargetScope.current.generation + 1,
		};
	}
	const targetGeneration = currentTargetScope.current.generation;
	const mounted = useRef(true);
	const composeGeneration = useRef(0);
	const isCurrentTarget = () =>
		mounted.current &&
		currentTargetScope.current.generation === targetGeneration;
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			composeGeneration.current += 1;
		};
	}, []);
	return { composeGeneration, isCurrentTarget, target, targetScope };
}

/** The palette's result-type tabs: fixed lanes, sidebar sections and app sections. */
export function usePaletteSearchTabs(
	commandSearchSections: ReturnType<
		typeof useCommandSearchSections
	>["sections"],
	contributedSidebarSections: PluginContributions["sidebar_sections"]
) {
	return useMemo<CommandPaletteTab[]>(
		() => [
			{ id: "all", label: "All" },
			{ id: "messages", label: "Messages", icon: Chat01Icon },
			{ id: "pages", label: "Pages", icon: DeliverySecure01Icon },
			{ id: "marketplace", label: "Marketplace", icon: Package01Icon },
			...commandSearchSections.map((section) => ({
				icon: section.icon,
				id: section.id,
				label: section.label,
			})),
			...contributedSidebarSections
				.slice()
				.sort(
					(a, b) =>
						(a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title)
				)
				.map((section) => ({
					id: `plugin:${section.plugin}:${section.id}`,
					label: section.title,
					icon: PlugSocketIcon,
				})),
		],
		[commandSearchSections, contributedSidebarSections]
	);
}

/** Opens the image picker and stages each pick for the palette's compose box. */
export function pickComposeImages({
	composeGeneration,
	isCurrentTarget,
	setComposeImages,
	target,
}: {
	composeGeneration: RefObject<number>;
	isCurrentTarget: () => boolean;
	setComposeImages: Dispatch<SetStateAction<AttachedImage[]>>;
	target: ApiTarget;
}) {
	const generation = composeGeneration.current;
	const input = document.createElement("input");
	input.accept = "image/*";
	input.multiple = true;
	input.type = "file";
	input.onchange = () => {
		if (!isCurrentTarget() || generation !== composeGeneration.current) {
			return;
		}
		for (const file of Array.from(input.files ?? [])) {
			if (!file.type.startsWith("image/")) {
				continue;
			}
			void stageImageUpload(target, file)
				.then(({ dataUrl, upload }) => {
					if (!isCurrentTarget() || generation !== composeGeneration.current) {
						return;
					}
					setComposeImages((previous) => [
						...previous,
						{
							id: upload?.id ?? `img-${crypto.randomUUID()}`,
							filename: file.name,
							url: dataUrl,
							mimeType: file.type,
							size: file.size,
						},
					]);
				})
				.catch((error) => {
					if (!isCurrentTarget() || generation !== composeGeneration.current) {
						return;
					}
					toast.error("Could not attach image", {
						description:
							error instanceof Error
								? error.message
								: "Please try another image.",
					});
				});
		}
	};
	input.click();
}
