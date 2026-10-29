// apps/desktop/src/components/store/EnginesCatalogSection.tsx
//
// The unified Engines section in the Store. One tab, grouped by modality:
// Text and Embedding · Image · Speech · Sandboxes. Each group lists that
// modality's local engines (the catalog's `provider` / `media` / `voice`
// categories) — NOT models.
//
// Uses the shared Store master-detail layout (left list, right preview) like
// Plugins, Models, MCP, and Skills.
//
// Two interaction models:
//   - Text (chat) engines are mutually exclusive — exactly one is the resident
//     engine, so the toggle SWAPS the active engine (re-points the gateway).
//   - Image / Speech engines run *alongside* Chat, so their toggle is
//     a plain start/stop of the engine's sidecar process.

import { LayerIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	EngineFootnote,
	EngineInstallButton,
	type EngineInstallState,
	EnginesErrorState,
} from "@ryu/blocks/desktop/store-engines.tsx";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import StoreItemAction, {
	StoreItemOverflowMenu,
	storeItemContextMenu,
} from "@ryu/marketplace/catalog/chrome/store-item-action";
import StoreShelfHeading from "@ryu/marketplace/catalog/chrome/store-shelf-heading";
import {
	ListingAsideCard,
	ListingDetailShell,
	ListingHero,
	ListingInfoGrid,
	ListingSection,
	ListingStatStrip,
} from "@ryu/marketplace/catalog/detail/listing-detail-shell";
import { engineLogoProps } from "@ryu/marketplace/catalog/engine-logos";
import { safeHttpUrl } from "@ryu/marketplace/catalog/safe-url";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { RadioGroup, RadioGroupItem } from "@ryu/ui/components/radio-group.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import {
	StatusBadge,
	type StatusKind,
} from "@ryu/ui/components/status-badge.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { type ComponentProps, useMemo, useRef, useState } from "react";
import { AudioCppEngineSettings } from "@/src/components/inference/AudioCppEngineSettings.tsx";
import { EngineInferenceSettings } from "@/src/components/inference/EngineInferenceSettings.tsx";
import { EngineLaunchConfigSection } from "@/src/components/inference/ModelLaunchConfigSection.tsx";
import { SpeechProcessingEngineSettings } from "@/src/components/inference/SpeechProcessingEngineSettings.tsx";
import { SttTranscriptionSettings } from "@/src/components/inference/SttTranscriptionSettings.tsx";
import { TtsEngineSettings } from "@/src/components/settings/TtsEngineSettings.tsx";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import { useLlamacppAcceleration } from "@/src/hooks/useLlamacppAcceleration.ts";
import { useOrgFeatures } from "@/src/hooks/useOrgFeatures.ts";
import {
	type PluginSettingsOpener,
	usePluginSettingsOpener,
} from "@/src/hooks/usePluginSettingsOpener.ts";
import {
	type SandboxBackendEntry,
	useSandboxBackends,
} from "@/src/hooks/useSandboxBackends.ts";
import { useVoiceAuthority } from "@/src/hooks/useVoiceAuthority.ts";
import {
	useVoiceEngines,
	type VoiceEngineEntry,
} from "@/src/hooks/useVoiceEngines.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

const SEARCH_DEBOUNCE_MS = 200;

/** Run-alongside (start/stop) categories, in display order under their headers. */
const RUN_ALONGSIDE_CATEGORIES = ["media", "voice"] as const;
const RESTARTABLE_CORE_CHAT_ENGINES = new Set([
	"llamacpp",
	"vllm",
	"sglang",
	"mlx",
	"mlx-vlm",
]);

const GROUP_LABELS = {
	text: "Text and Embedding",
	media: "Image",
	voice: "Speech",
	sandbox: "Sandboxes",
} satisfies Record<EngineListKind, string>;

/** Human label for an OS family id (as Core reports it in `platforms`). Only the
 *  OS family: a CPU-arch requirement (e.g. Apple Silicon) comes from Core's
 *  `unsupported_reason`, since one `macos` entry may run on both arches. */
const PLATFORM_LABELS = new Map<string, string>([
	["macos", "macOS"],
	["windows", "Windows"],
	["linux", "Linux"],
]);

type EngineListKind = "text" | "media" | "voice" | "sandbox";

interface EngineListItem {
	/** False when this node's OS can't run the engine — no Install is offered. */
	available: boolean;
	/** Uninstall is withheld while the engine is the resident/running one. */
	canUninstall: boolean;
	description: string;
	displayName: string;
	/** The node says a newer build is actually reachable (drives forced install). */
	hasUpdate: boolean;
	id: string;
	/** Installed (text/image/speech) or detected on the node (sandbox backends). */
	installed: boolean;
	/** Null for rows with no install lifecycle of their own (sandbox backends,
	 *  which are detected on the node rather than installed by Ryu). */
	installState: EngineInstallState | null;
	kind: EngineListKind;
	name: string;
	/** The row's live STATE, as the shared status glyph plus the word it shows on
	 *  hover. It used to be a bare `string | null` rendered as a grey text badge;
	 *  three words ("Active", "Running", "Default") repeated down a two-column
	 *  grid is most of what made the section look noisy, and none of them said
	 *  anything the glyph cannot.
	 *
	 *  `label` overrides the kind's default word, which is what lets an image or
	 *  speech engine say "Running" while wearing the same green check a text
	 *  engine's "Active" does — they are the same state under two vocabularies. */
	status: { kind: StatusKind; label?: string } | null;
	/** Current toggle position: active (text) / running (image, speech) /
	 *  default (sandbox). */
	toggled: boolean;
	/** Unknown process state cannot safely offer start/stop. */
	toggleKnown?: boolean;
	/** Why it is unavailable (Core's reason, else a platforms message). */
	unavailableReason?: string;
}

type PendingKind = "install" | "uninstall" | "toggle";

interface RowState {
	error: string | null;
	gatewayStale: boolean;
	pending: PendingKind | null;
}

const EMPTY_ROW_STATE: RowState = {
	pending: null,
	error: null,
	gatewayStale: false,
};

function LiveEngineInstallButton({
	engineName,
	statusKnown = true,
	...props
}: { engineName: string; statusKnown?: boolean } & Omit<
	ComponentProps<typeof EngineInstallButton>,
	"percent"
>) {
	const { percent } = useInstallProgress(
		["engine", "voice", "media", "embedding"],
		engineName
	);
	return statusKnown ? (
		<EngineInstallButton percent={percent} {...props} />
	) : (
		<span className="text-muted-foreground text-xs">Status unknown</span>
	);
}

/**
 * Why the connected node can't run an engine. Core's `unsupported_reason` wins:
 * it knows the node's OS, CPU arch, and any operator-placed binary. The
 * `platforms` message is only the fallback for an older Core that omits it.
 */
function unsupportedReason(
	platforms: string[],
	coreReason?: string | null
): string {
	const fromCore = coreReason?.trim();
	if (fromCore) {
		return fromCore;
	}
	if (platforms.length === 0) {
		return "Not available on this node";
	}
	const labels = platforms.map((p) => PLATFORM_LABELS.get(p) ?? p).join(" / ");
	return `Requires ${labels} — the connected node can't run it`;
}

/**
 * Whether to offer an update for this engine — the NODE's verdict, not a version
 * comparison made here.
 *
 * Comparing `installedVersion` to `latestVersion` client-side is what made this
 * button a lie: engines whose downloader pins its tag at compile time can never
 * reach the upstream version the catalog used to advertise, so the row showed an
 * update forever and pressing it hit an already-installed fast path in Core that
 * did nothing at all.
 */
function hasEngineUpdate(engine: { updateAvailable: boolean }): boolean {
	return engine.updateAvailable;
}

/** Where to get each sandbox runtime, for the row that cannot install it.
 *
 *  Ryu deliberately never installs Docker: `crates/core/sandbox/src/docker.rs`
 *  carries a LOCKED DECISION (issue #191) to stay detection-only, enforced by a
 *  committed `detect_does_not_install_docker` test. That is not squeamishness —
 *  on macOS the cask still ends in a EULA modal and a privileged-helper prompt,
 *  on Linux the package needs root and `docker` group membership is
 *  root-equivalent, and on Windows it needs admin plus WSL2 plus a reboot. An
 *  "install" that ends with the user typing an admin password is a slower version
 *  of telling them to install it.
 *
 *  What was NOT defensible is what the row said about it. A non-interactive
 *  "Not detected" chip and a sentence reading "install its CLI on the node" named
 *  nothing, linked nowhere, and offered no action — so the honest answer ("Ryu
 *  will not install this one, here is where to get it") was indistinguishable
 *  from a broken feature.
 *
 *  The default "needs elevated privileges" copy is true for the container
 *  runtimes. A backend whose install needs no admin rights, or whose
 *  not-detected state is not always a missing install, overrides it with
 *  `notDetected`. */
interface SandboxInstallDocs {
	href: string;
	/** Replaces the default not-detected sentence in the row and its badge. */
	notDetected?: string;
	what: string;
}

const SANDBOX_INSTALL_DOCS = new Map<string, SandboxInstallDocs>([
	[
		"docker",
		{
			href: "https://docs.docker.com/get-started/get-docker/",
			what: "Docker Desktop or Colima",
		},
	],
	[
		"microsandbox",
		{
			href: "https://github.com/microsandbox/microsandbox",
			what: "the microsandbox CLI",
		},
	],
	[
		"opensandbox",
		{
			href: "https://github.com/agentsea/opensandbox",
			what: "the opensandbox CLI",
		},
	],
	[
		"mxc",
		{
			href: "https://github.com/microsoft/mxc",
			// MXC needs no admin setup, and an installed wxc-exec still reads as not
			// detected when this Windows build is unsupported or the only isolation
			// tier left needs host permission edits the operator has not allowed.
			notDetected:
				"Not detected. Ryu does not install MXC, and installing it needs no administrator rights: put wxc-exec on PATH or point RYU_SANDBOX_MXC_BINARY at it. If wxc-exec is already installed, this Windows build may be unsupported, or MXC may need RYU_SANDBOX_MXC_ALLOW_DACL_MUTATION=1 to edit host file permissions for each run.",
			what: "the MXC wxc-exec executor",
		},
	],
]);

/** Platforms a sandbox runtime exists on, mirroring Core's node-support gate. */
const SANDBOX_PLATFORMS = new Map<string, string[]>([
	["microsandbox", ["linux", "macos"]],
	["opensandbox", ["linux", "macos"]],
	["mxc", ["windows"]],
	["singularity", ["linux"]],
]);

function sandboxDescription(backend: SandboxBackendEntry): string {
	if (!backend.supported) {
		return unsupportedReason(SANDBOX_PLATFORMS.get(backend.name) ?? []);
	}
	if (backend.detected) {
		return "Detected on this node and ready to use.";
	}
	if (backend.name === "wasmtime") {
		return "Built-in WASM sandbox (compile with the sandbox-wasmtime feature).";
	}
	const docs = SANDBOX_INSTALL_DOCS.get(backend.name);
	if (!docs) {
		return "Not detected — install its CLI on the node to use it.";
	}
	return (
		docs.notDetected ??
		`Not detected. Ryu does not install this one — it needs elevated privileges on every platform — so install ${docs.what} yourself and it is picked up automatically.`
	);
}

function useRowStates() {
	const { authority, isCurrent } = useVoiceAuthority("engine-row-actions");
	const pendingRows = useRef(
		new Map<string, { authority: typeof authority }>()
	);
	const [rowView, setRowView] = useState({
		authority,
		rows: {} as Record<string, RowState>,
	});
	const rowStates = rowView.authority === authority ? rowView.rows : {};
	const rowState = (name: string): RowState =>
		rowStates[name] ?? EMPTY_ROW_STATE;
	const patchRow = (name: string, patch: Partial<RowState>) => {
		if (!isCurrent()) {
			return;
		}
		setRowView((prev) => {
			const rows = prev.authority === authority ? prev.rows : {};
			return {
				authority,
				rows: {
					...rows,
					[name]: { ...(rows[name] ?? EMPTY_ROW_STATE), ...patch },
				},
			};
		});
	};
	const runAction = async (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => {
		if (
			!isCurrent() ||
			pendingRows.current.get(name)?.authority === authority
		) {
			return;
		}
		const ticket = { authority };
		pendingRows.current.set(name, ticket);
		patchRow(name, { pending: kind, error: null, gatewayStale: false });
		try {
			await action();
		} catch (e) {
			if (isCurrent()) {
				patchRow(name, {
					error: e instanceof Error ? e.message : `Failed to ${kind} ${name}`,
				});
			}
		} finally {
			if (pendingRows.current.get(name) === ticket) {
				pendingRows.current.delete(name);
				if (isCurrent()) {
					patchRow(name, { pending: null });
				}
			}
		}
	};
	return { rowState, patchRow, runAction };
}

interface EngineToggleLabel {
	disable?: string;
	enable: string;
}

/** Per-kind wording for the engine toggle, so the menu says what the toggle
 *  actually does: a text engine is SWAPPED to (it can never be switched off — the
 *  node always has a resident engine), image/speech engines start and stop, and a
 *  sandbox backend is picked as the default. */
const TOGGLE_LABELS = {
	text: { enable: "Set as active" },
	media: { enable: "Start", disable: "Stop" },
	voice: { enable: "Start", disable: "Stop" },
	sandbox: { enable: "Set as default" },
} satisfies Record<EngineListKind, EngineToggleLabel>;

/**
 * The inline lifecycle control on an engine card — the SAME {@link StoreItemAction}
 * Apps, Plugins, Skills, MCP and Agents cards use, so an engine installs from the
 * list without first opening its preview.
 *
 * Its own component (not a node built in the list's `useMemo`) because the live
 * download percent comes from a hook, which can't run per-item inside a memo.
 *
 * Rows with nothing to offer render a status Badge instead of an empty 3-dot menu:
 * an engine this node can't run, and one whose only action would be a toggle it is
 * already in (the resident text engine, the default sandbox — neither can be
 * switched off, only swapped away from by picking another row).
 */
/**
 * The right-click rows for an engine card — the same branches
 * {@link EngineCardAction} takes, restated for the context-menu primitive.
 *
 * `undefined` (no menu at all) for the two rows that genuinely have no verb: an
 * engine this platform cannot run, and a sandbox runtime Ryu only DETECTS. Both
 * already say so in their status badge, and a menu whose single row is greyed
 * out teaches nothing the badge did not.
 */
function engineCardContextMenu({
	busy,
	item,
	onInstall,
	onOpenSettings,
	onToggle,
	onUninstall,
}: {
	busy: boolean;
	item: EngineListItem;
	onInstall: (item: EngineListItem) => void;
	onOpenSettings?: (() => void) | null;
	onToggle: (item: EngineListItem, next: boolean) => void;
	onUninstall: (item: EngineListItem) => void;
}) {
	if (busy || item.toggleKnown === false) {
		return undefined;
	}
	if (!item.available) {
		// A node that can no longer run an installed engine can still reclaim its
		// disk space: Remove is the only action left on offer.
		return item.installed && item.canUninstall
			? storeItemContextMenu({
					installed: true,
					onUninstall: () => onUninstall(item),
				})
			: undefined;
	}
	const labels: EngineToggleLabel = TOGGLE_LABELS[item.kind];
	if (!item.installed) {
		if (item.installState === null) {
			return undefined;
		}
		return storeItemContextMenu({
			installed: false,
			onInstall: () => onInstall(item),
			onOpenSettings: onOpenSettings ?? undefined,
		});
	}
	// `toggleKnown === false` already returned above, so only the toggle state
	// itself decides which direction is on offer.
	const canToggleOn = !item.toggled;
	const canToggleOff = item.toggled && Boolean(labels.disable);
	return storeItemContextMenu({
		disableLabel: labels.disable,
		enabled: item.toggled,
		enableLabel: labels.enable,
		installed: true,
		onDisable: canToggleOff ? () => onToggle(item, false) : undefined,
		onEnable: canToggleOn ? () => onToggle(item, true) : undefined,
		onOpenSettings: onOpenSettings ?? undefined,
		onUninstall: item.canUninstall ? () => onUninstall(item) : undefined,
	});
}

function EngineCardAction({
	item,
	busy,
	onInstall,
	onUninstall,
	onToggle,
	onOpenSettings,
}: {
	busy: boolean;
	item: EngineListItem;
	onInstall: (item: EngineListItem) => void;
	onToggle: (item: EngineListItem, next: boolean) => void;
	onUninstall: (item: EngineListItem) => void;
	/** Set for an engine that is ALSO an installed plugin with settings (a voice
	 *  or sandbox backend shipped as an app); null for the rest. */
	onOpenSettings?: (() => void) | null;
}) {
	const { percent } = useInstallProgress(
		["engine", "voice", "media", "embedding"],
		item.name
	);
	const labels: EngineToggleLabel = TOGGLE_LABELS[item.kind];

	if (item.toggleKnown === false) {
		return (
			<span className="text-muted-foreground text-xs">Status unknown</span>
		);
	}

	if (!item.available) {
		return (
			// The glyph's hover label carries the node's reason when the row has
			// one; the detail hero and footnote repeat it in full.
			<div className="flex items-center gap-1">
				<StatusBadge
					kind="unavailable"
					label={item.unavailableReason ?? "Not supported on this platform"}
				/>
				{/* Remove stays available for an installed engine this node can no
				    longer run, so its disk space can be reclaimed. */}
				{item.installed && item.canUninstall ? (
					<StoreItemAction
						busy={busy}
						installed
						onUninstall={() => onUninstall(item)}
					/>
				) : null}
			</div>
		);
	}

	if (!item.installed) {
		// A sandbox backend has no install lifecycle in Ryu — its CLI is detected on
		// the node or it isn't — so it gets a status, not an Install button that
		// could not do anything.
		if (item.installState === null) {
			// Not a bare chip: this row can never gain an Install button (Ryu is
			// detection-only for sandbox runtimes), so a dead badge is the ONLY thing
			// the user would ever see here. The glyph carries the reason on hover and
			// the link is the action the row is actually able to offer.
			const docs = SANDBOX_INSTALL_DOCS.get(item.name);
			return (
				<div className="flex items-center gap-1">
					<StatusBadge
						kind="unavailable"
						label={
							docs
								? (docs.notDetected ??
									`Not detected. Ryu does not install ${item.displayName} — it needs elevated privileges on every platform. Install ${docs.what} and it is picked up automatically.`)
								: "Not detected on this node"
						}
					/>
					{docs ? (
						<Button
							render={
								<a
									href={safeHttpUrl(docs.href) ?? undefined}
									rel="noopener noreferrer"
									target="_blank"
								/>
							}
							size="sm"
							variant="ghost"
						>
							How to install
						</Button>
					) : null}
				</div>
			);
		}
		return (
			<StoreItemAction
				busy={busy || item.installState === "installing"}
				installed={false}
				onInstall={() => onInstall(item)}
				onOpenSettings={onOpenSettings ?? undefined}
				percent={percent}
			/>
		);
	}

	// `toggleKnown === false` already returned above, so only the toggle state
	// itself decides which direction is on offer.
	const canToggleOn = !item.toggled;
	const canToggleOff = item.toggled && Boolean(labels.disable);
	// Nothing left to offer (the resident text engine and the default sandbox can
	// only be swapped away from, by picking another row) → render nothing rather
	// than a 3-dot menu that opens empty. The row's status badge, which such a row
	// always carries ("Active" / "Default"), already says where it stands.
	if (!(canToggleOn || canToggleOff || item.canUninstall)) {
		// …unless it is configurable, in which case the menu is not empty after all.
		return onOpenSettings ? (
			<StoreItemOverflowMenu onOpenSettings={onOpenSettings} />
		) : null;
	}

	return (
		<StoreItemAction
			busy={busy}
			disableLabel={labels.disable}
			enabled={item.toggled}
			enableLabel={labels.enable}
			installed
			onDisable={canToggleOff ? () => onToggle(item, false) : undefined}
			onEnable={canToggleOn ? () => onToggle(item, true) : undefined}
			onOpenSettings={onOpenSettings ?? undefined}
			onUninstall={item.canUninstall ? () => onUninstall(item) : undefined}
			percent={percent}
		/>
	);
}

function EngineList({
	groups,
	loading,
	error,
	selectedId,
	onSelect,
	rowState,
	onInstall,
	onUninstall,
	onToggle,
	onClearSearch,
	settingsOpener,
}: {
	/** Resolves a row to its settings tab; null for an engine that is not an
	 *  installed plugin, which is most of them. */
	settingsOpener: PluginSettingsOpener;
	groups: { kind: EngineListKind; items: EngineListItem[] }[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onInstall: (item: EngineListItem) => void;
	onSelect: (id: string) => void;
	onToggle: (item: EngineListItem, next: boolean) => void;
	onUninstall: (item: EngineListItem) => void;
	onClearSearch: () => void;
	rowState: (name: string) => RowState;
}) {
	const total = groups.reduce((n, g) => n + g.items.length, 0);

	if (loading && total === 0) {
		return <SkeletonRows inset="catalog" />;
	}
	if (error && total === 0) {
		return (
			<div className="p-4 text-sm text-status-destructive">
				Couldn't load engines: {error}
			</div>
		);
	}
	if (total === 0) {
		return (
			<Empty className="h-full" inset="dense">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LayerIcon} />
					</EmptyMedia>
					<EmptyTitle>No engines found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={onClearSearch} size="sm" variant="ghost">
						Clear search
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	return (
		<div className="flex flex-col gap-6 pt-2">
			{groups.map((group) => (
				<section key={group.kind}>
					<StoreShelfHeading>{GROUP_LABELS[group.kind]}</StoreShelfHeading>
					<StoreCardGrid>
						{group.items.map((item) => {
							const errorMessage = rowState(item.name).error;
							return (
								<StoreCatalogCard
									action={
										<div className="flex flex-col items-end gap-1">
											<div className="flex items-center gap-2">
												{item.status ? (
													<StatusBadge
														kind={item.status.kind}
														label={item.status.label}
													/>
												) : null}
												<EngineCardAction
													busy={rowState(item.name).pending !== null}
													item={item}
													onInstall={onInstall}
													onOpenSettings={settingsOpener(item.name)}
													onToggle={onToggle}
													onUninstall={onUninstall}
												/>
											</div>
											{errorMessage ? (
												<div role="alert">
													<EngineFootnote tone="destructive">
														{errorMessage}
													</EngineFootnote>
												</div>
											) : null}
										</div>
									}
									contextMenu={engineCardContextMenu({
										busy: rowState(item.name).pending !== null,
										item,
										onInstall,
										onOpenSettings: settingsOpener(item.name),
										onToggle,
										onUninstall,
									})}
									description={item.description}
									// An engine that cannot run on this platform is dimmed, never
									// hidden — the platform answer is exactly what the user came to
									// find. Its status glyph carries the reason.
									dimmed={!item.available}
									key={item.id}
									{...engineLogoProps(item.name)}
									name={item.displayName}
									onClick={() => onSelect(item.id)}
									selected={item.id === selectedId}
								/>
							);
						})}
					</StoreCardGrid>
				</section>
			))}
		</div>
	);
}

/** The engine whose build can be swapped between CPU and GPU. */
const ACCELERATION_ENGINE = "llamacpp";

/**
 * CPU-vs-GPU build picker for llama.cpp.
 *
 * Written for someone who does not know what CUDA, Metal or Vulkan are: the
 * first line states what is happening right now in plain words, "Automatic" is
 * the default and is marked recommended, and the builds this device cannot
 * run are visibly disabled with the reason next to them rather than hidden
 * (hiding them makes the list look arbitrary; showing why is what teaches).
 */
function EngineAccelerationSection() {
	const { acceleration, loading, switching, error, select } =
		useLlamacppAcceleration();

	if (loading && !acceleration) {
		return (
			<ListingSection title="Speed">
				<SkeletonRows />
			</ListingSection>
		);
	}
	if (!acceleration) {
		return null;
	}

	const { selected, resolvedLabel, hasGpu, gpuName, vram, options } =
		acceleration;
	const hardware = hasGpu
		? `Graphics card detected${gpuName ? `: ${gpuName}` : ""}${vram ? ` (${vram})` : ""}.`
		: "No usable graphics card detected on this device.";

	return (
		<ListingSection title="Speed">
			<p className="text-muted-foreground text-sm leading-relaxed">
				{hardware} Right now this engine runs on{" "}
				<span className="text-foreground">{resolvedLabel}</span>. Leave this on
				Automatic unless something is going wrong — Ryu picks the fastest option
				your device can actually run.
			</p>
			<RadioGroup
				aria-label="How llama.cpp runs"
				className="mt-3"
				disabled={switching}
				onValueChange={(value) => {
					void select(String(value));
				}}
				value={selected}
			>
				<div className="flex items-start gap-2.5">
					<RadioGroupItem
						className="mt-0.5"
						id="llamacpp-accel-auto"
						value="auto"
					/>
					<div className="flex flex-col gap-0.5">
						<Label htmlFor="llamacpp-accel-auto" variant="choice">
							Automatic
							<Badge variant="secondary">Recommended</Badge>
						</Label>
						<p className="text-muted-foreground text-xs">
							Detects your hardware and uses the fastest option available.
						</p>
					</div>
				</div>
				{options.map((option) => {
					const id = `llamacpp-accel-${option.id}`;
					return (
						<div
							className={
								option.available
									? "flex items-start gap-2.5"
									: "flex items-start gap-2.5 opacity-60"
							}
							key={option.id}
						>
							<RadioGroupItem
								className="mt-0.5"
								disabled={!option.available}
								id={id}
								value={option.id}
							/>
							<div className="flex flex-col gap-0.5">
								<Label htmlFor={id} variant="choice">
									{option.label}
								</Label>
								<p className="text-muted-foreground text-xs">
									{option.available
										? option.description
										: option.unavailableReason}
								</p>
							</div>
						</div>
					);
				})}
			</RadioGroup>
			{switching && (
				<p className="mt-2 flex items-center gap-2 text-muted-foreground text-sm">
					<Spinner className="size-4" />
					Downloading and switching the build…
				</p>
			)}
			{error && <EngineFootnote tone="destructive">{error}</EngineFootnote>}
		</ListingSection>
	);
}

/**
 * Image and speech engines whose detail page shows a launch settings section,
 * with the copy that explains when the settings apply.
 */
const LAUNCH_SETTINGS_DESCRIPTIONS = new Map<string, string>([
	[
		"sdcpp",
		"Hardware and loading options for sd-server. Restart the engine to apply changes. If Core adopted an external server, its flags remain controlled by that server's owner.",
	],
	[
		"outetts",
		"Hardware and synthesis options passed to llama-tts. Changes apply to the next spoken reply.",
	],
	[
		"audiocpp",
		"Server options passed to audiocpp_server, in addition to the Audio runtime settings below. Restart the engine to apply changes. If Core adopted an external server, its flags remain controlled by that server's owner.",
	],
	[
		"ryutts",
		"Runtime and download options for the Ryu Audio sidecar, applied as its process environment. Restart the engine to apply changes. If Core adopted an external server, its environment stays controlled by that server's owner.",
	],
]);

function EngineDetailPanel({
	selectedId,
	textEngines,
	voiceEngines,
	sandboxBackends,
	textLoading,
	voiceLoading,
	sandboxLoading,
	textError,
	voiceError,
	sandboxError,
	installText,
	uninstallText,
	activateText,
	restartText,
	installVoice,
	uninstallVoice,
	setVoiceRunning,
	selectSandbox,
	rowState,
	patchRow,
	runAction,
}: {
	selectedId: string | null;
	textEngines: ReturnType<typeof useEngines>["engines"];
	voiceEngines: VoiceEngineEntry[];
	sandboxBackends: SandboxBackendEntry[];
	textLoading: boolean;
	voiceLoading: boolean;
	sandboxLoading: boolean;
	textError: string | null;
	voiceError: string | null;
	sandboxError: string | null;
	installText: (name: string, force?: boolean) => Promise<void>;
	uninstallText: (name: string) => Promise<void>;
	activateText: (name: string) => Promise<{ gatewayRefreshed: boolean }>;
	restartText: ReturnType<typeof useEngines>["restart"];
	installVoice: (name: string, force?: boolean) => Promise<void>;
	uninstallVoice: (name: string) => Promise<void>;
	setVoiceRunning: (name: string, running: boolean) => Promise<void>;
	selectSandbox: (name: string) => Promise<void>;
	rowState: (name: string) => RowState;
	patchRow: (name: string, patch: Partial<RowState>) => void;
	runAction: (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => Promise<void>;
}) {
	// Org feature toggle: an organization can turn engine updates off. Core
	// refuses the forced reinstall; the panel just stops offering it.
	const { isEnabled: orgFeatureEnabled } = useOrgFeatures();
	const canUpdateEngine = (engine: { updateAvailable: boolean }) =>
		hasEngineUpdate(engine) && orgFeatureEnabled("engines.update");
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={LayerIcon} />
					</EmptyMedia>
					<EmptyTitle>No engine selected</EmptyTitle>
					<EmptyDescription>
						Pick an engine on the left to review its status and controls.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const [kind, name] = selectedId.split(":");

	if (kind === "text") {
		if (textLoading) {
			return <SkeletonRows rows={6} spacing="library" />;
		}
		const engine = textEngines.find((e) => e.name === name);
		if (!engine) {
			return null;
		}
		const state = rowState(engine.name);
		const isInstalled = engine.installState === "installed";
		const busy = state.pending !== null;
		const unsupported = !engine.supported;

		return (
			<ListingDetailShell
				actions={
					<>
						<LiveEngineInstallButton
							// An unsupported node can't Add or Update, but an installed
							// copy can still be removed to reclaim its disk space.
							busy={busy || (unsupported && !isInstalled)}
							disabledUninstall={engine.active}
							engineName={engine.name}
							hasUpdate={!unsupported && canUpdateEngine(engine)}
							installState={engine.installState}
							// Same button installs or updates: force only when the node
							// says a newer build is actually reachable, so a first
							// install keeps its cheap idempotent path.
							onInstall={() =>
								runAction(engine.name, "install", () =>
									installText(engine.name, canUpdateEngine(engine))
								)
							}
							onUninstall={() =>
								runAction(engine.name, "uninstall", () =>
									uninstallText(engine.name)
								)
							}
							pending={state.pending}
						/>
						<div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
							{engine.running &&
							RESTARTABLE_CORE_CHAT_ENGINES.has(engine.name) ? (
								<Button
									disabled={busy}
									onClick={() =>
										void runAction(engine.name, "toggle", () =>
											restartText(engine.name)
										)
									}
									size="sm"
									variant="outline"
								>
									Restart
								</Button>
							) : null}
							<span>Active engine</span>
							<Switch
								aria-label={`Set ${engine.displayName} as active engine`}
								checked={engine.active}
								disabled={!isInstalled || busy || unsupported || engine.active}
								onCheckedChange={() =>
									runAction(engine.name, "toggle", async () => {
										if (engine.active) {
											return;
										}
										const swap = await activateText(engine.name);
										if (!swap.gatewayRefreshed) {
											patchRow(engine.name, { gatewayStale: true });
										}
									})
								}
							/>
						</div>
					</>
				}
				aside={
					<ListingAsideCard title="Information">
						<ListingInfoGrid
							rows={[
								{ label: "Kind", value: GROUP_LABELS.text },
								{ label: "Engine ID", value: engine.name },
								{
									label: "Platforms",
									value: engine.platforms?.join(", ") || "All",
								},
							]}
						/>
					</ListingAsideCard>
				}
				hero={
					<ListingHero
						{...engineLogoProps(engine.name)}
						name={engine.displayName}
						statusIcons={
							<>
								{engine.active ? (
									<StatusBadge kind="active" tone="hero" />
								) : null}
								{unsupported ? (
									<StatusBadge
										kind="unavailable"
										label={unsupportedReason(
											engine.platforms,
											engine.unsupportedReason
										)}
										tone="hero"
									/>
								) : null}
							</>
						}
						tagline={engine.description}
					/>
				}
				stats={
					<ListingStatStrip
						items={[
							{ label: "Type", value: GROUP_LABELS.text },
							{
								label: "Install",
								value: isInstalled ? "Installed" : "Not installed",
							},
							{ label: "Binding", value: engine.active ? "Active" : "Idle" },
							{
								label: "Supported",
								value: engine.supported ? "Yes" : "No",
							},
						]}
					/>
				}
			>
				<ListingSection title="How this engine behaves">
					<p className="text-muted-foreground text-sm leading-relaxed">
						Text engines are mutually exclusive — only one can be the resident
						engine at a time. Toggling on swaps which engine Core binds local
						agents to.
					</p>
				</ListingSection>
				<ListingSection title="Advanced configuration">
					<EngineInferenceSettings engineId={engine.name} />
				</ListingSection>
				{engine.name === "llamacpp" ? (
					<ListingSection title="Embedding engine">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							Llama.cpp runs a separate embedding server for semantic search.
							These defaults apply to that server across agents and Spaces.
						</p>
						<EngineLaunchConfigSection engineId="llamacpp-embed" />
						<div className="mt-3 flex flex-wrap items-center gap-2">
							<Button
								disabled={rowState("llamacpp-embed").pending !== null}
								onClick={() =>
									void runAction("llamacpp-embed", "toggle", () =>
										restartText("llamacpp-embed")
									)
								}
								size="sm"
								variant="outline"
							>
								Restart embedding server
							</Button>
							{rowState("llamacpp-embed").error ? (
								<p className="text-status-destructive text-xs" role="alert">
									{rowState("llamacpp-embed").error}
								</p>
							) : null}
						</div>
					</ListingSection>
				) : null}
				{engine.name === "llamacpp" ? (
					<ListingSection title="Speech Processing defaults">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							S1-mini cleans up recognized text in Dictation. These settings are
							separate from Chat and shared with the Speech Processing layer on
							the Computer dialog's Voice & sandbox page.
						</p>
						<SpeechProcessingEngineSettings />
						<div className="mt-3">
							<EngineLaunchConfigSection engineId="llamacpp-speech" />
						</div>
					</ListingSection>
				) : null}
				{engine.name === "llamacpp" ? (
					<ListingSection title="Reranker and classifier servers">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							Llama.cpp also runs a reranker for Spaces search and a small
							classifier for routing and inspection. Each server keeps its own
							launch settings; changes apply the next time it starts.
						</p>
						<div className="flex flex-col gap-3">
							<EngineLaunchConfigSection engineId="llamacpp-rerank" />
							<EngineLaunchConfigSection engineId="llamacpp-classify" />
						</div>
					</ListingSection>
				) : null}
				{engine.name === ACCELERATION_ENGINE && isInstalled && (
					<EngineAccelerationSection />
				)}
				{unsupported && (
					<EngineFootnote>
						{unsupportedReason(engine.platforms, engine.unsupportedReason)}
					</EngineFootnote>
				)}
				{state.gatewayStale && (
					<EngineFootnote tone="amber">
						Engine active, but gateway routing was not refreshed.
					</EngineFootnote>
				)}
				{state.error && (
					<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
				)}
				{textError && (
					<EngineFootnote tone="destructive">{textError}</EngineFootnote>
				)}
			</ListingDetailShell>
		);
	}

	if (kind === "media" || kind === "voice") {
		if (voiceLoading) {
			return <SkeletonRows rows={6} spacing="library" />;
		}
		const engine = voiceEngines.find((e) => e.name === name);
		if (!engine) {
			return null;
		}
		const state = rowState(engine.name);
		const isInstalled = engine.installState === "installed";
		const busy = state.pending !== null;
		// Core decides support for the node it runs on (OS + arch + placed
		// binaries) and refuses to start an unsupported engine; mirror it here.
		const unsupported = !engine.supported;

		return (
			<ListingDetailShell
				actions={
					<>
						<LiveEngineInstallButton
							// Add and Update need support; Remove does not.
							busy={busy || (unsupported && !isInstalled)}
							disabledUninstall={!engine.runningKnown || engine.running}
							engineName={engine.name}
							hasUpdate={!unsupported && canUpdateEngine(engine)}
							installState={engine.installState}
							onInstall={() =>
								runAction(engine.name, "install", () =>
									installVoice(engine.name, canUpdateEngine(engine))
								)
							}
							onUninstall={() =>
								runAction(engine.name, "uninstall", () =>
									uninstallVoice(engine.name)
								)
							}
							pending={state.pending}
							statusKnown={engine.runningKnown}
						/>
						<div className="ml-auto flex shrink-0 items-center gap-2 text-sm">
							{engine.runningKnown && engine.running ? (
								<Button
									disabled={busy}
									onClick={() =>
										void runAction(engine.name, "toggle", async () => {
											await setVoiceRunning(engine.name, false);
											await setVoiceRunning(engine.name, true);
										})
									}
									size="sm"
									variant="outline"
								>
									Restart
								</Button>
							) : null}
							<span>Running</span>
							<Switch
								aria-label={`Start or stop ${engine.displayName}`}
								checked={engine.running}
								disabled={
									!isInstalled || busy || unsupported || !engine.runningKnown
								}
								onCheckedChange={() =>
									runAction(engine.name, "toggle", () =>
										setVoiceRunning(engine.name, !engine.running)
									)
								}
							/>
						</div>
					</>
				}
				aside={
					<ListingAsideCard title="Information">
						<ListingInfoGrid
							rows={[
								{ label: "Kind", value: GROUP_LABELS[kind] },
								{ label: "Engine ID", value: engine.name },
								{
									label: "Platforms",
									value: engine.platforms.join(", ") || "All",
								},
								{
									label: "Process",
									value: engine.runningKnown
										? engine.running
											? "Running"
											: "Stopped"
										: "Unknown",
								},
							]}
						/>
					</ListingAsideCard>
				}
				hero={
					<ListingHero
						{...engineLogoProps(engine.name)}
						name={engine.displayName}
						statusIcons={
							<>
								{engine.runningKnown && engine.running ? (
									<StatusBadge kind="active" label="Running" tone="hero" />
								) : null}
								{unsupported ? (
									<StatusBadge
										kind="unavailable"
										label={unsupportedReason(
											engine.platforms,
											engine.unsupportedReason
										)}
										tone="hero"
									/>
								) : null}
							</>
						}
						tagline={engine.description}
					/>
				}
				stats={
					<ListingStatStrip
						items={[
							{ label: "Type", value: GROUP_LABELS[kind] },
							{
								label: "Install",
								value: isInstalled ? "Installed" : "Not installed",
							},
							{
								label: "Process",
								value: engine.runningKnown
									? engine.running
										? "Running"
										: "Stopped"
									: "Unknown",
							},
						]}
					/>
				}
			>
				<ListingSection title="How this engine behaves">
					<p className="text-muted-foreground text-sm leading-relaxed">
						Image and speech engines run alongside the active text engine. Use
						the toggle to start or stop this engine's sidecar process.
					</p>
				</ListingSection>
				{engine.name === "ryutts" ? (
					<ListingSection title="Text-to-speech defaults">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							Choose the default speech engine and voice for desktop read-aloud
							and voice replies. These defaults are shared across the desktop
							app.
						</p>
						<TtsEngineSettings sectionTitle={null} />
					</ListingSection>
				) : null}
				{engine.name === "whispercpp" ? (
					<ListingSection title="Speech recognition settings">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							Choose the CPU thread count and whisper-server flags for this
							transcription engine. If Core adopted an external server, its
							process flags remain controlled by that server's owner.
						</p>
						<SttTranscriptionSettings engineId="whispercpp" />
						<div className="mt-3">
							<EngineLaunchConfigSection engineId="whispercpp" />
						</div>
					</ListingSection>
				) : null}
				{engine.name === "whispercpp" ? (
					<ListingSection title="Core Parakeet settings">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							Parakeet is a separate in-process STT path. Ryu stores these
							options for this engine, but its current inference library uses
							its own defaults.
						</p>
						<SttTranscriptionSettings
							adapterSupported={false}
							engineId="parakeet"
						/>
					</ListingSection>
				) : null}
				{engine.name === "whispercpp" ? (
					<ListingSection title="Gateway speech recognition settings">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							Gateway routes speech recognition to its configured provider. Ryu
							saves this profile per node, but the current Gateway request path
							does not forward these recognition options.
						</p>
						<SttTranscriptionSettings
							adapterNote="Saved for Gateway speech recognition. The current Gateway adapter does not apply these fields to provider requests."
							adapterSupported={false}
							engineId="gateway"
						/>
					</ListingSection>
				) : null}
				{LAUNCH_SETTINGS_DESCRIPTIONS.has(engine.name) ? (
					<ListingSection title="Engine launch settings">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							{LAUNCH_SETTINGS_DESCRIPTIONS.get(engine.name)}
						</p>
						<EngineLaunchConfigSection engineId={engine.name} />
					</ListingSection>
				) : null}
				{engine.name === "audiocpp" ? (
					<ListingSection title="Audio runtime settings">
						<p className="mb-3 text-muted-foreground text-sm leading-relaxed">
							These node-wide hardware settings apply to audio.cpp's speech
							recognition and voice generation models. If Core adopted an
							external server, hardware settings remain controlled by that
							server's owner.
						</p>
						<AudioCppEngineSettings />
						<div className="mt-4">
							<SttTranscriptionSettings
								adapterNote="audio.cpp receives language, temperature, prompt, and Additional fields. Other typed Whisper options are saved but skipped by this adapter."
								engineId="audiocpp"
							/>
						</div>
					</ListingSection>
				) : null}
				{unsupported && (
					<EngineFootnote>
						{unsupportedReason(engine.platforms, engine.unsupportedReason)}
					</EngineFootnote>
				)}
				{state.error && (
					<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
				)}
				{voiceError && (
					<EngineFootnote tone="destructive">{voiceError}</EngineFootnote>
				)}
			</ListingDetailShell>
		);
	}

	if (kind === "sandbox") {
		if (sandboxLoading) {
			return <SkeletonRows rows={6} spacing="library" />;
		}
		const backend = sandboxBackends.find((b) => b.name === name);
		if (!backend) {
			return null;
		}
		const state = rowState(backend.name);
		const busy = state.pending !== null;
		const selectable = backend.supported;

		return (
			<ListingDetailShell
				actions={
					<label className="flex items-center gap-2 text-sm">
						Default backend
						<Switch
							aria-label={`Set ${backend.displayName} as the default sandbox backend`}
							checked={backend.isDefault}
							disabled={!selectable || busy || backend.isDefault}
							onCheckedChange={() =>
								runAction(backend.name, "toggle", async () => {
									if (backend.isDefault) {
										return;
									}
									await selectSandbox(backend.name);
								})
							}
						/>
					</label>
				}
				aside={
					<ListingAsideCard title="Information">
						<ListingInfoGrid
							rows={[
								{ label: "Kind", value: GROUP_LABELS.sandbox },
								{ label: "Backend ID", value: backend.name },
								{
									label: "Detected",
									value: backend.detected ? "Yes" : "No",
								},
							]}
						/>
					</ListingAsideCard>
				}
				hero={
					<ListingHero
						{...engineLogoProps(backend.name)}
						name={backend.displayName}
						statusIcons={
							<>
								{backend.isDefault ? (
									<StatusBadge kind="default" tone="hero" />
								) : null}
								{backend.supported ? null : (
									<StatusBadge
										kind="unavailable"
										label="Not supported on this platform"
										tone="hero"
									/>
								)}
							</>
						}
						tagline={sandboxDescription(backend)}
					/>
				}
				stats={
					<ListingStatStrip
						items={[
							{ label: "Type", value: GROUP_LABELS.sandbox },
							{
								label: "Runtime",
								value: backend.detected ? "Detected" : "Missing",
							},
							{
								label: "Default",
								value: backend.isDefault ? "Yes" : "No",
							},
							{
								label: "Supported",
								value: backend.supported ? "Yes" : "No",
							},
						]}
					/>
				}
			>
				<ListingSection title="How this backend behaves">
					<p className="text-muted-foreground text-sm leading-relaxed">
						Sandbox backends pick the default runtime the sandbox_exec tool uses
						when a call omits an explicit backend. Only one can be the default
						at a time.
					</p>
				</ListingSection>
				{backend.supported && !backend.detected && (
					<EngineFootnote tone="amber">
						Not detected on the node — calls fall back to unavailable until its
						runtime is installed.
					</EngineFootnote>
				)}
				{!backend.supported && (
					<EngineFootnote>
						{unsupportedReason(SANDBOX_PLATFORMS.get(backend.name) ?? [])}
					</EngineFootnote>
				)}
				{state.error && (
					<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
				)}
				{sandboxError && (
					<EngineFootnote tone="destructive">{sandboxError}</EngineFootnote>
				)}
			</ListingDetailShell>
		);
	}

	return null;
}

export default function EnginesCatalogSection({
	selectedEngineId,
	onCloseEngine,
}: {
	selectedEngineId?: string;
	onCloseEngine?: () => void;
} = {}) {
	// Some engines ship as installed plugins with their own settings (a voice
	// backend, a sandbox provider); the resolver returns null for the rest.
	const settingsOpener = usePluginSettingsOpener();
	const [query, setQuery] = useState("");
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [localSelectedId, setSelectedId] = useState<string | null>(null);
	const selectedId = selectedEngineId ?? localSelectedId;
	const { rowState, patchRow, runAction } = useRowStates();

	const {
		engines: textEngines,
		loading: textLoading,
		error: textError,
		install: installText,
		uninstall: uninstallText,
		activate: activateText,
		restart: restartText,
		reload: reloadText,
	} = useEngines();
	const { isEnabled: orgFeatureEnabled } = useOrgFeatures();
	const engineUpdatesAllowed = orgFeatureEnabled("engines.update");

	const {
		engines: voiceEngines,
		loading: voiceLoading,
		error: voiceError,
		install: installVoice,
		uninstall: uninstallVoice,
		reload: reloadVoice,
		setRunning: setVoiceRunning,
	} = useVoiceEngines(RUN_ALONGSIDE_CATEGORIES);

	const {
		backends: sandboxBackends,
		loading: sandboxLoading,
		error: sandboxError,
		reload: reloadSandbox,
		select: selectSandbox,
	} = useSandboxBackends();

	const loading = textLoading || voiceLoading || sandboxLoading;
	const error = textError ?? voiceError ?? sandboxError;

	const groups = useMemo(() => {
		const q = debouncedQuery.trim().toLowerCase();
		const matches = (displayName: string, description: string) =>
			!q ||
			displayName.toLowerCase().includes(q) ||
			description.toLowerCase().includes(q);

		const textItems: EngineListItem[] = textEngines
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => ({
				id: `text:${e.name}`,
				kind: "text" as const,
				name: e.name,
				displayName: e.displayName,
				description: e.description,
				status: e.active ? ({ kind: "active" } as const) : null,
				installState: e.installState,
				installed: e.installState === "installed",
				available: e.supported,
				...(e.supported
					? {}
					: {
							unavailableReason: unsupportedReason(
								e.platforms,
								e.unsupportedReason
							),
						}),
				hasUpdate: engineUpdatesAllowed && hasEngineUpdate(e),
				toggled: e.active,
				// The resident engine can't be removed out from under the node.
				canUninstall: e.installState === "installed" && !e.active,
			}));

		const runAlongside = (
			e: VoiceEngineEntry,
			kind: "media" | "voice"
		): EngineListItem => ({
			id: `${kind}:${e.name}`,
			kind,
			name: e.name,
			displayName: e.displayName,
			description: e.description,
			status:
				e.runningKnown && e.running
					? ({ kind: "active", label: "Running" } as const)
					: null,
			installState: e.installState,
			installed: e.installState === "installed",
			// The node's verdict (OS + arch); Core also refuses to start it.
			available: e.supported,
			...(e.supported
				? {}
				: {
						unavailableReason: unsupportedReason(
							e.platforms,
							e.unsupportedReason
						),
					}),
			hasUpdate: engineUpdatesAllowed && hasEngineUpdate(e),
			toggled: e.running,
			toggleKnown: e.runningKnown,
			// Stop it before removing it, so a live sidecar is never pulled away.
			canUninstall:
				e.installState === "installed" && e.runningKnown && !e.running,
		});

		const mediaItems: EngineListItem[] = voiceEngines
			.filter((e) => e.category === "media")
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => runAlongside(e, "media"));

		const voiceItems: EngineListItem[] = voiceEngines
			.filter((e) => e.category === "voice")
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => runAlongside(e, "voice"));

		const sandboxItems: EngineListItem[] = sandboxBackends
			.filter((b) => matches(b.displayName, sandboxDescription(b)))
			.map((b) => ({
				id: `sandbox:${b.name}`,
				kind: "sandbox" as const,
				name: b.name,
				displayName: b.displayName,
				description: sandboxDescription(b),
				status: b.isDefault ? ({ kind: "default" } as const) : null,
				// Ryu never installs a sandbox backend — its runtime is detected on the
				// node — so the row carries no install lifecycle at all.
				installState: null,
				installed: b.detected,
				available: b.supported,
				hasUpdate: false,
				toggled: b.isDefault,
				canUninstall: false,
			}));

		return [
			{ kind: "text" as const, items: textItems },
			{ kind: "media" as const, items: mediaItems },
			{ kind: "voice" as const, items: voiceItems },
			{ kind: "sandbox" as const, items: sandboxItems },
		].filter((g) => g.items.length > 0);
	}, [
		textEngines,
		voiceEngines,
		sandboxBackends,
		debouncedQuery,
		engineUpdatesAllowed,
	]);

	// Card-level lifecycle, so an engine installs / starts / swaps straight from the
	// list — the same affordance Apps and Plugins cards have. Each dispatches on the
	// row's kind to the hook that owns it, and goes through `runAction` so the row's
	// pending + error state is the one the detail panel already shows.
	const handleInstall = (item: EngineListItem) => {
		runAction(item.name, "install", () =>
			item.kind === "text"
				? installText(item.name, item.hasUpdate)
				: installVoice(item.name, item.hasUpdate)
		);
	};

	const handleUninstall = (item: EngineListItem) => {
		runAction(item.name, "uninstall", () =>
			item.kind === "text"
				? uninstallText(item.name)
				: uninstallVoice(item.name)
		);
	};

	const handleToggle = (item: EngineListItem, next: boolean) => {
		runAction(item.name, "toggle", async () => {
			if (item.kind === "text") {
				const swap = await activateText(item.name);
				if (!swap.gatewayRefreshed) {
					patchRow(item.name, { gatewayStale: true });
				}
				return;
			}
			if (item.kind === "sandbox") {
				await selectSandbox(item.name);
				return;
			}
			await setVoiceRunning(item.name, next);
		});
	};

	if (error && groups.length === 0 && !loading) {
		return (
			<EnginesErrorState
				message={error}
				onRetry={() => {
					void Promise.all([reloadText(), reloadVoice(), reloadSandbox()]);
				}}
			/>
		);
	}

	const selectedName = selectedId?.split(":")[1] ?? null;

	return (
		<StoreCatalogLayout
			detail={
				<EngineDetailPanel
					activateText={activateText}
					installText={installText}
					installVoice={installVoice}
					patchRow={patchRow}
					restartText={restartText}
					rowState={rowState}
					runAction={runAction}
					sandboxBackends={sandboxBackends}
					sandboxError={sandboxError}
					sandboxLoading={sandboxLoading}
					selectedId={selectedId}
					selectSandbox={selectSandbox}
					setVoiceRunning={setVoiceRunning}
					textEngines={textEngines}
					textError={textError}
					textLoading={textLoading}
					uninstallText={uninstallText}
					uninstallVoice={uninstallVoice}
					voiceEngines={voiceEngines}
					voiceError={voiceError}
					voiceLoading={voiceLoading}
				/>
			}
			detailOnly={selectedEngineId !== undefined}
			detailTitle={selectedName ?? "Engine"}
			hasSelection={selectedId != null}
			list={
				<EngineList
					error={error}
					groups={groups}
					loading={loading}
					onClearSearch={() => setQuery("")}
					onInstall={handleInstall}
					onSelect={setSelectedId}
					onToggle={handleToggle}
					onUninstall={handleUninstall}
					rowState={rowState}
					selectedId={selectedId}
					settingsOpener={settingsOpener}
				/>
			}
			onCloseDetail={() => {
				setSelectedId(null);
				onCloseEngine?.();
			}}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search engines…",
			}}
		/>
	);
}

/** The same engine controls and lifecycle used by Store, hosted in Library. */
export function EngineDetailsDialog({
	engineId,
	onClose,
}: {
	engineId: string;
	onClose: () => void;
}) {
	return (
		<EnginesCatalogSection
			onCloseEngine={onClose}
			selectedEngineId={engineId}
		/>
	);
}
