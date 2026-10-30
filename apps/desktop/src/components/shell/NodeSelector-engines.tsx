import {
	Database01Icon,
	Image01Icon,
	LayerIcon,
	RankingIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { useQuery } from "@tanstack/react-query";
import { sileo } from "sileo";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { fetchActiveEngine, setActiveEngine } from "@/src/lib/api/engines.ts";
import {
	type EngineConcurrency,
	fetchEngineConcurrency,
	fetchSidecarDetails,
	type SidecarDetail,
	startSidecar,
	stopSidecar,
} from "@/src/lib/api/plugins.ts";
import {
	type CatalogItem,
	fetchCatalog,
	installSidecar,
	uninstallSidecar,
} from "@/src/lib/services-api.ts";
import { type LayerOption, NodeLayerMenu } from "./NodeLayerMenu.tsx";
import { PanelSection } from "./NodePanelNav.tsx";
import { ServiceRow, usageCaption } from "./NodeSelector-service-row.tsx";

/** The run-alongside modality groups the CATALOG drives, in display order. These
 *  map to the catalog's SidecarCategory: voice=speech, media=image.
 *  The `provider` (chat) category is NOT here — it is the single mutually-
 *  exclusive slot and gets its own swap layer. Agents/tools aren't engines.
 *
 *  `embedding` is deliberately absent even though the category exists. No
 *  embedding engine is a Store entry (see the NOTE in Core's
 *  `catalog/registry.rs`, test-locked at `embedding.len() == 0`): the local
 *  embeddings server is backing infrastructure that auto-starts, so it is
 *  rendered below as a status-driven row instead. Listing it here produced a
 *  group that was filtered out for having zero items on every node ever — i.e.
 *  the reason the dropdown had no Embeddings row at all. */
const RUN_ALONGSIDE_GROUPS: Array<{
	category: CatalogItem["category"];
	icon: IconSvgElement;
	label: string;
}> = [{ label: "Image", category: "media", icon: Image01Icon }];

/**
 * The two llama.cpp-derived engines that serve retrieval, keyed by their sidecar
 * name. Neither is a catalog entry (see {@link RUN_ALONGSIDE_GROUPS}), so they
 * are driven straight off `/api/sidecar/status`, which reports both: the
 * embeddings server from `startup_order`, the reranker from the registered-but-
 * not-auto-started tail.
 *
 * The reranker's `idleTone` is the load-bearing bit: Core starts it lazily on
 * the first Space search, so "stopped" is its healthy resting state, not a
 * fault.
 */
const RETRIEVAL_ENGINES: Array<{
	icon: IconSvgElement;
	idleCaption?: string;
	idleTone?: "down" | "neutral";
	key: string;
	label: string;
}> = [
	{
		key: "llamacpp-embed",
		label: "Embeddings",
		icon: Database01Icon,
		// In `startup_order` — down really does mean broken here.
		idleCaption: "Stopped · semantic search falls back to keywords",
	},
	{
		key: "llamacpp-rerank",
		label: "Reranker",
		icon: RankingIcon,
		idleTone: "neutral",
		idleCaption: "Idle · wakes on the first Space search",
	},
];

/**
 * The "Engines" block in the node dropdown: every installed engine runtime
 * (chat / speech / image / embeddings) with its running state, live memory/CPU
 * usage, and a start/stop toggle. Joins the catalog (what's installed + its
 * modality) with `/api/sidecar/status` (running + resource sample), polling on
 * the same 5s cadence as the rest of the status spine. Renders nothing until at
 * least one engine is installed.
 */
/**
 * Compact live "N/M slots · K queued" badge for the local-engine admission
 * queue. Renders nothing when the engine is idle (no slots busy, nothing
 * queued) so the panel stays quiet until the engine is actually under load
 * (Ryu's fan-out: delegate / threads / teams). Prefers the gateway's
 * admission view; falls back to the engine's own `/slots` count.
 */
function EngineQueueBadge({
	concurrency,
}: {
	concurrency: EngineConcurrency | null;
}) {
	const tl = useLiteralMessages();
	if (!concurrency) {
		return null;
	}
	const busy = concurrency.engineBusy ?? concurrency.inFlight;
	const total = concurrency.engineTotal ?? concurrency.maxInFlight;
	const { queued } = concurrency;
	if (busy <= 0 && queued <= 0) {
		return null;
	}
	const slots = total > 0 ? `${busy}/${total} slots` : `${busy} busy`;
	return (
		<span className="font-medium text-muted-foreground/70 text-xs tabular-nums">
			{slots}
			{queued > 0 ? ` ${tl("· {queued} queued", { queued })}` : ""}
		</span>
	);
}

/**
 * The node's engine spine: the catalog (what's installed), a live sidecar sample
 * (running + memory/CPU), the resident chat and the admission-queue depth.
 *
 * Both engine-bearing sections share this ONE query — same key, same fetcher, so
 * React Query serves them from a single 5s poll instead of two.
 */
export function useNodeEngines(target: ApiTarget) {
	const query = useQuery({
		queryKey: ["node-engines", target.url],
		queryFn: async () => {
			const [catalog, details, active, concurrency] = await Promise.all([
				fetchCatalog(target.url, target.token, undefined, target.userJwt),
				fetchSidecarDetails(target).catch(
					() =>
						/* SAFETY: This failure fallback constructs an empty object locally; there are no sidecar entries to violate SidecarDetail. */ ({}) as Record<
							string,
							SidecarDetail
						>
				),
				// The resident chat (mutually-exclusive slot). Best-effort:
				// on failure we fall back to the running provider below.
				fetchActiveEngine(target).catch(() => null),
				// Live admission-queue + slot depth (Layer 2). Best-effort.
				fetchEngineConcurrency(target).catch(() => null),
			]);
			return {
				catalog,
				details,
				active: active?.active ?? null,
				concurrency,
			};
		},
		refetchInterval: 5000,
	});

	return {
		catalog: query.data?.catalog ?? [],
		details: query.data?.details ?? {},
		activeChat: query.data?.active ?? null,
		concurrency: query.data?.concurrency ?? null,
		refresh: async () => {
			await query.refetch();
		},
	};
}

/** Install a catalog engine on `target`, reporting either outcome. */
export async function installEngine(
	target: ApiTarget,
	item: CatalogItem,
	tl: LiteralMessage
) {
	try {
		await installSidecar(
			target.url,
			target.token,
			item.name,
			false,
			undefined,
			target.userJwt
		);
		sileo.success({ title: `Installing ${item.displayName}` });
	} catch (e) {
		sileo.error({
			title:
				e instanceof Error
					? e.message
					: tl("Couldn't install {displayName}", {
							displayName: item.displayName,
						}),
		});
	}
}

export function EnginesSection({ target }: { target: ApiTarget }) {
	const tl = useLiteralMessages();
	const { catalog, details, activeChat, concurrency, refresh } =
		useNodeEngines(target);

	/** Install a not-yet-present engine, then reconcile the list. */
	const install = async (item: CatalogItem) => {
		await installEngine(target, item, tl);
		await refresh();
	};

	const uninstall = async (item: CatalogItem) => {
		try {
			await uninstallSidecar(
				target.url,
				target.token,
				item.name,
				target.userJwt
			);
			sileo.success({ title: `Removed ${item.displayName}` });
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: tl("Couldn't remove {displayName}", {
								displayName: item.displayName,
							}),
			});
		}
		await refresh();
	};

	/** Swap the resident chat. NOT a sidecar start/stop — the mutually-
	 *  exclusive slot moves via `/api/engine/active`, which also stops the engine
	 *  it displaced and refreshes the gateway's model list. */
	const activate = async (item: CatalogItem) => {
		try {
			const swap = await setActiveEngine(target, item.name);
			if (!swap.unchanged) {
				sileo.success({ title: `Chat → ${item.displayName}` });
			}
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: tl("Couldn't switch to {displayName}", {
								displayName: item.displayName,
							}),
			});
		}
		await refresh();
	};

	/** Start/stop one run-alongside engine (speech / image / embeddings). */
	const toggleEngine = async (item: CatalogItem, next: boolean) => {
		try {
			if (next) {
				await startSidecar(target, item.name);
			} else {
				await stopSidecar(target, item.name);
			}
			// Give the process a moment to settle before re-polling status.
			await new Promise<void>((resolve) => setTimeout(resolve, 1000));
		} catch (e) {
			sileo.error({
				title:
					e instanceof Error
						? e.message
						: `Couldn't ${next ? "start" : "stop"} ${item.displayName}`,
			});
		}
		await refresh();
	};

	/** Not-installed rows, shared by every engine layer. Unsupported entries stay
	 *  visible but inert, with the reason where the version badge would go. */
	const availableOptions = (items: CatalogItem[]): LayerOption[] =>
		items
			.filter((item) => item.installState !== "installed")
			.map((item) => ({
				name: item.name,
				label: item.displayName,
				detail:
					item.installState === "installing"
						? "installing…"
						: item.latestVersion,
				disabled: !item.supported,
				disabledReason: "unsupported here",
				select: () => install(item),
			}));

	const providers = catalog.filter((item) => item.category === "provider");
	const chatInstalled = providers.filter(
		(item) => item.installState === "installed"
	);
	// Prefer the engine Core reports as resident; fall back to whichever provider
	// is actually running, so a Core without the surface still reads correctly.
	const activeChatName =
		activeChat ??
		chatInstalled.find((item) => details[item.name]?.running)?.name ??
		null;
	const activeChatItem =
		chatInstalled.find((item) => item.name === activeChatName) ?? null;
	const chatRunning = activeChatItem
		? (details[activeChatItem.name]?.running ?? false)
		: null;
	const chatUsage = activeChatItem
		? usageCaption(details[activeChatItem.name])
		: null;

	const groups = RUN_ALONGSIDE_GROUPS.map((group) => ({
		...group,
		items: catalog.filter((item) => item.category === group.category),
	})).filter((group) => group.items.length > 0);

	// Presence in the status map, not a hardcoded assumption: an older Core that
	// doesn't report a key simply doesn't get the row, and an unreachable node
	// (empty map) fabricates none.
	const retrieval = RETRIEVAL_ENGINES.filter((engine) => engine.key in details);

	if (providers.length === 0 && groups.length === 0 && retrieval.length === 0) {
		return null;
	}

	return (
		<PanelSection
			title="Engines"
			trailing={<EngineQueueBadge concurrency={concurrency} />}
		>
			{providers.length > 0 && (
				// The single mutually-exclusive chat slot. No start/stop and no
				// per-engine update: engine downloads are pinned to a compile-time
				// target (the catalog's upstream `latestVersion` is informational) and
				// they upgrade with the app.
				<NodeLayerMenu
					available={availableOptions(providers)}
					caption={
						activeChatItem
							? chatRunning
								? tl("Resident chat · {usage}", {
										usage: chatUsage ?? "running",
									})
								: tl("Resident chat · idle")
							: "No chat selected"
					}
					currentLabel={activeChatItem?.displayName ?? "None"}
					icon={LayerIcon}
					installed={chatInstalled.map(
						(item): LayerOption => ({
							name: item.name,
							label: item.displayName,
							active: item.name === activeChatName,
							detail: item.installedVersion,
							select: () => activate(item),
							// Never offer to remove the engine currently bound to local
							// agents — swap off it first, then it becomes removable.
							uninstall:
								item.name === activeChatName
									? undefined
									: () => uninstall(item),
						})
					)}
					label="Chat"
					running={chatRunning}
					version={activeChatItem?.installedVersion}
				/>
			)}
			{groups.map((group) => {
				const installed = group.items.filter(
					(item) => item.installState === "installed"
				);
				const runningItems = installed.filter(
					(item) => details[item.name]?.running
				);
				let currentLabel: string;
				if (runningItems.length > 0) {
					currentLabel = runningItems.map((i) => i.displayName).join(", ");
				} else if (installed.length > 0) {
					currentLabel = "None running";
				} else {
					currentLabel = "Not installed";
				}
				return (
					<NodeLayerMenu
						available={availableOptions(group.items)}
						caption={
							installed.length > 0
								? tl(
										"{running} of {installed} running · these run alongside Chat",
										{
											running: runningItems.length,
											installed: installed.length,
										}
									)
								: "Nothing installed yet"
						}
						currentLabel={currentLabel}
						icon={group.icon}
						installed={installed.map(
							(item): LayerOption => ({
								name: item.name,
								label: item.displayName,
								active: details[item.name]?.running ?? false,
								detail:
									usageCaption(details[item.name]) ?? item.installedVersion,
								select: () =>
									toggleEngine(item, !(details[item.name]?.running ?? false)),
								uninstall: () => uninstall(item),
							})
						)}
						key={group.label}
						label={group.label}
						running={installed.length === 0 ? null : runningItems.length > 0}
						selectionMode="toggle"
					/>
				);
			})}
			{/* The retrieval engines. Both are llama.cpp processes on their own
			    ports, started/stopped as sidecars — not swappable, so they get a
			    status row each rather than a catalog-backed group. */}
			{retrieval.map((engine) => (
				<ServiceRow
					currentLabel="llama.cpp"
					detail={details[engine.key]}
					icon={engine.icon}
					idleCaption={engine.idleCaption}
					idleTone={engine.idleTone}
					key={engine.key}
					label={engine.label}
					onChanged={refresh}
					running={details[engine.key]?.running ?? null}
					sidecarKey={engine.key}
					target={target}
				/>
			))}
		</PanelSection>
	);
}
