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
//   - Image / Speech engines run *alongside* the chat engine, so their toggle is
//     a plain start/stop of the engine's sidecar process.

import { CpuIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	EngineFootnote,
	EngineInstallButton,
	EnginesErrorState,
	installStateBadge,
} from "@ryu/blocks/desktop/store-engines";
import StoreCatalogCard from "@ryu/marketplace/catalog/chrome/store-catalog-card";
import StoreCatalogLayout, {
	StoreCardGrid,
} from "@ryu/marketplace/catalog/chrome/store-catalog-layout";
import { Badge } from "@ryu/ui/components/badge";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Spinner } from "@ryu/ui/components/spinner";
import { Switch } from "@ryu/ui/components/switch";
import { type ComponentProps, useMemo, useState } from "react";
import { useDebouncedValue } from "@/src/hooks/use-debounced-value.ts";
import { useEngines } from "@/src/hooks/useEngines.ts";
import {
	type SandboxBackendEntry,
	useSandboxBackends,
} from "@/src/hooks/useSandboxBackends.ts";
import {
	useVoiceEngines,
	type VoiceEngineEntry,
} from "@/src/hooks/useVoiceEngines.ts";
import { useInstallProgress } from "@/src/store/useDownloadsStore.ts";

const SEARCH_DEBOUNCE_MS = 200;

/** Run-alongside (start/stop) categories, in display order under their headers. */
const RUN_ALONGSIDE_CATEGORIES = ["media", "voice"] as const;

const GROUP_LABELS: Record<string, string> = {
	text: "Text and Embedding",
	media: "Image",
	voice: "Speech",
	sandbox: "Sandboxes",
};

/** Human label for an OS family id (as Core reports it in `platforms`). */
const PLATFORM_LABELS: Record<string, string> = {
	macos: "macOS (Apple Silicon)",
	windows: "Windows",
	linux: "Linux",
};

type EngineListKind = "text" | "media" | "voice" | "sandbox";

interface EngineListItem {
	description: string;
	displayName: string;
	id: string;
	kind: EngineListKind;
	name: string;
	statusLabel: string | null;
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
	...props
}: { engineName: string } & Omit<
	ComponentProps<typeof EngineInstallButton>,
	"percent"
>) {
	const { percent } = useInstallProgress(
		["engine", "voice", "media", "embedding"],
		engineName
	);
	return <EngineInstallButton percent={percent} {...props} />;
}

function unsupportedReason(platforms: string[]): string {
	if (platforms.length === 0) {
		return "Not available on this node";
	}
	const labels = platforms.map((p) => PLATFORM_LABELS[p] ?? p).join(" / ");
	return `Requires ${labels} — the connected node can't run it`;
}

function hasEngineUpdate(engine: {
	installState: string;
	installedVersion: string | null;
	latestVersion: string | null;
	deprecated: boolean;
}): boolean {
	return (
		engine.installState === "installed" &&
		engine.installedVersion != null &&
		engine.latestVersion != null &&
		engine.latestVersion !== engine.installedVersion &&
		!engine.deprecated
	);
}

function sandboxDescription(backend: SandboxBackendEntry): string {
	if (!backend.supported) {
		return unsupportedReason(
			backend.name === "microsandbox" || backend.name === "opensandbox"
				? ["linux", "macos"]
				: []
		);
	}
	if (backend.detected) {
		return "Detected on this node and ready to use.";
	}
	if (backend.name === "wasmtime") {
		return "Built-in WASM sandbox (compile with the sandbox-wasmtime feature).";
	}
	return "Not detected — install its CLI on the node to use it.";
}

function useRowStates() {
	const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
	const rowState = (name: string): RowState =>
		rowStates[name] ?? EMPTY_ROW_STATE;
	const patchRow = (name: string, patch: Partial<RowState>) => {
		setRowStates((prev) => ({
			...prev,
			[name]: { ...(prev[name] ?? EMPTY_ROW_STATE), ...patch },
		}));
	};
	const runAction = async (
		name: string,
		kind: PendingKind,
		action: () => Promise<void>
	) => {
		patchRow(name, { pending: kind, error: null, gatewayStale: false });
		try {
			await action();
		} catch (e) {
			patchRow(name, {
				error: e instanceof Error ? e.message : `Failed to ${kind} ${name}`,
			});
		} finally {
			patchRow(name, { pending: null });
		}
	};
	return { rowState, patchRow, runAction };
}

function EngineList({
	groups,
	loading,
	error,
	selectedId,
	onSelect,
}: {
	groups: { kind: EngineListKind; items: EngineListItem[] }[];
	loading: boolean;
	error: string | null;
	selectedId: string | null;
	onSelect: (id: string) => void;
}) {
	const total = groups.reduce((n, g) => n + g.items.length, 0);

	if (loading && total === 0) {
		return (
			<div className="flex items-center justify-center p-8 text-muted-foreground">
				<Spinner className="size-5" />
			</div>
		);
	}
	if (error && total === 0) {
		return (
			<div className="p-4 text-destructive text-sm">
				Couldn't load engines: {error}
			</div>
		);
	}
	if (total === 0) {
		return (
			<Empty className="h-full p-6">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={CpuIcon} />
					</EmptyMedia>
					<EmptyTitle>No engines found</EmptyTitle>
					<EmptyDescription>Try a different search.</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="flex flex-col gap-6 pt-2">
			{groups.map((group) => (
				<section key={group.kind}>
					<h3 className="mb-2 px-1 font-medium text-muted-foreground text-xs uppercase tracking-widest">
						{GROUP_LABELS[group.kind]}
					</h3>
					<StoreCardGrid>
						{group.items.map((item) => (
							<StoreCatalogCard
								action={
									item.statusLabel ? (
										<Badge variant="secondary">{item.statusLabel}</Badge>
									) : undefined
								}
								description={item.description}
								icon={<HugeiconsIcon className="size-5" icon={CpuIcon} />}
								key={item.id}
								name={item.displayName}
								onClick={() => onSelect(item.id)}
								seedId={item.id}
								selected={item.id === selectedId}
							/>
						))}
					</StoreCardGrid>
				</section>
			))}
		</div>
	);
}

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
	installText: (name: string) => Promise<void>;
	uninstallText: (name: string) => Promise<void>;
	activateText: (name: string) => Promise<{ gatewayRefreshed: boolean }>;
	installVoice: (name: string) => Promise<void>;
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
	if (!selectedId) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={CpuIcon} />
					</EmptyMedia>
					<EmptyTitle>No engine selected</EmptyTitle>
					<EmptyDescription>
						Pick an engine on the left to review its status and controls.
					</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	const [kind, name] = selectedId.split(":") as [EngineListKind, string];

	if (kind === "text") {
		if (textLoading) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					<Spinner className="size-5" />
				</div>
			);
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
			<div className="scroll-fade-effect-y flex h-full flex-col gap-6 overflow-auto p-4">
				<header className="flex flex-col gap-3">
					<div className="flex items-start justify-between gap-3 pr-8">
						<div className="min-w-0">
							<h2 className="truncate font-semibold text-xl">
								{engine.displayName}
							</h2>
							<p className="text-muted-foreground text-sm">
								{GROUP_LABELS.text}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-3">
							<LiveEngineInstallButton
								busy={busy || unsupported}
								disabledUninstall={engine.active}
								engineName={engine.name}
								hasUpdate={hasEngineUpdate(engine)}
								installState={engine.installState}
								onInstall={() =>
									runAction(engine.name, "install", () =>
										installText(engine.name)
									)
								}
								onUninstall={() =>
									runAction(engine.name, "uninstall", () =>
										uninstallText(engine.name)
									)
								}
								pending={state.pending}
							/>
							<Switch
								aria-label={`Set ${engine.displayName} as active engine`}
								checked={engine.active}
								disabled={!isInstalled || busy || unsupported}
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
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{installStateBadge(engine.installState)}
						{engine.active && <Badge>Active</Badge>}
					</div>
					<p className="text-muted-foreground text-sm">{engine.description}</p>
					{unsupported && (
						<EngineFootnote>
							{unsupportedReason(engine.platforms)}
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
				</header>
				<section className="text-muted-foreground text-sm">
					<p>
						Text engines are mutually exclusive — only one can be the resident
						engine at a time. Toggling on swaps which engine Core binds local
						agents to.
					</p>
				</section>
			</div>
		);
	}

	if (kind === "media" || kind === "voice") {
		if (voiceLoading) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					<Spinner className="size-5" />
				</div>
			);
		}
		const engine = voiceEngines.find((e) => e.name === name);
		if (!engine) {
			return null;
		}
		const state = rowState(engine.name);
		const isInstalled = engine.installState === "installed";
		const busy = state.pending !== null;

		return (
			<div className="scroll-fade-effect-y flex h-full flex-col gap-6 overflow-auto p-4">
				<header className="flex flex-col gap-3">
					<div className="flex items-start justify-between gap-3 pr-8">
						<div className="min-w-0">
							<h2 className="truncate font-semibold text-xl">
								{engine.displayName}
							</h2>
							<p className="text-muted-foreground text-sm">
								{GROUP_LABELS[kind]}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-3">
							<LiveEngineInstallButton
								busy={busy}
								disabledUninstall={engine.running}
								engineName={engine.name}
								hasUpdate={hasEngineUpdate(engine)}
								installState={engine.installState}
								onInstall={() =>
									runAction(engine.name, "install", () =>
										installVoice(engine.name)
									)
								}
								onUninstall={() =>
									runAction(engine.name, "uninstall", () =>
										uninstallVoice(engine.name)
									)
								}
								pending={state.pending}
							/>
							<Switch
								aria-label={`Start or stop ${engine.displayName}`}
								checked={engine.running}
								disabled={!isInstalled || busy}
								onCheckedChange={() =>
									runAction(engine.name, "toggle", () =>
										setVoiceRunning(engine.name, !engine.running)
									)
								}
							/>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{installStateBadge(engine.installState)}
						{engine.running && <Badge>Running</Badge>}
					</div>
					<p className="text-muted-foreground text-sm">{engine.description}</p>
					{state.error && (
						<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
					)}
					{voiceError && (
						<EngineFootnote tone="destructive">{voiceError}</EngineFootnote>
					)}
				</header>
				<section className="text-muted-foreground text-sm">
					<p>
						Image and speech engines run alongside the active text engine. Use
						the toggle to start or stop this engine's sidecar process.
					</p>
				</section>
			</div>
		);
	}

	if (kind === "sandbox") {
		if (sandboxLoading) {
			return (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					<Spinner className="size-5" />
				</div>
			);
		}
		const backend = sandboxBackends.find((b) => b.name === name);
		if (!backend) {
			return null;
		}
		const state = rowState(backend.name);
		const busy = state.pending !== null;
		const selectable = backend.supported;

		return (
			<div className="scroll-fade-effect-y flex h-full flex-col gap-6 overflow-auto p-4">
				<header className="flex flex-col gap-3">
					<div className="flex items-start justify-between gap-3 pr-8">
						<div className="min-w-0">
							<h2 className="truncate font-semibold text-xl">
								{backend.displayName}
							</h2>
							<p className="text-muted-foreground text-sm">
								{GROUP_LABELS.sandbox}
							</p>
						</div>
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
					</div>
					<div className="flex flex-wrap items-center gap-2">
						{installStateBadge(
							backend.detected ? "installed" : "not_installed"
						)}
						{backend.isDefault && <Badge>Default</Badge>}
					</div>
					<p className="text-muted-foreground text-sm">
						{sandboxDescription(backend)}
					</p>
					{backend.supported && !backend.detected && (
						<EngineFootnote tone="amber">
							Not detected on the node — calls fall back to unavailable until
							its runtime is installed.
						</EngineFootnote>
					)}
					{!backend.supported && (
						<EngineFootnote>
							{unsupportedReason(
								backend.name === "microsandbox" ||
									backend.name === "opensandbox"
									? ["linux", "macos"]
									: []
							)}
						</EngineFootnote>
					)}
					{state.error && (
						<EngineFootnote tone="destructive">{state.error}</EngineFootnote>
					)}
					{sandboxError && (
						<EngineFootnote tone="destructive">{sandboxError}</EngineFootnote>
					)}
				</header>
				<section className="text-muted-foreground text-sm">
					<p>
						Sandbox backends pick the default runtime the sandbox_exec tool uses
						when a call omits an explicit backend. Only one can be the default
						at a time.
					</p>
				</section>
			</div>
		);
	}

	return null;
}

export default function EnginesCatalogSection() {
	const [query, setQuery] = useState("");
	const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const { rowState, patchRow, runAction } = useRowStates();

	const {
		engines: textEngines,
		loading: textLoading,
		error: textError,
		install: installText,
		uninstall: uninstallText,
		activate: activateText,
	} = useEngines();

	const {
		engines: voiceEngines,
		loading: voiceLoading,
		error: voiceError,
		install: installVoice,
		uninstall: uninstallVoice,
		setRunning: setVoiceRunning,
	} = useVoiceEngines(RUN_ALONGSIDE_CATEGORIES);

	const {
		backends: sandboxBackends,
		loading: sandboxLoading,
		error: sandboxError,
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
				statusLabel: e.active ? "Active" : null,
			}));

		const mediaItems: EngineListItem[] = voiceEngines
			.filter((e) => e.category === "media")
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => ({
				id: `media:${e.name}`,
				kind: "media" as const,
				name: e.name,
				displayName: e.displayName,
				description: e.description,
				statusLabel: e.running ? "Running" : null,
			}));

		const voiceItems: EngineListItem[] = voiceEngines
			.filter((e) => e.category === "voice")
			.filter((e) => matches(e.displayName, e.description))
			.map((e) => ({
				id: `voice:${e.name}`,
				kind: "voice" as const,
				name: e.name,
				displayName: e.displayName,
				description: e.description,
				statusLabel: e.running ? "Running" : null,
			}));

		const sandboxItems: EngineListItem[] = sandboxBackends
			.filter((b) => matches(b.displayName, sandboxDescription(b)))
			.map((b) => ({
				id: `sandbox:${b.name}`,
				kind: "sandbox" as const,
				name: b.name,
				displayName: b.displayName,
				description: sandboxDescription(b),
				statusLabel: b.isDefault ? "Default" : null,
			}));

		return [
			{ kind: "text" as const, items: textItems },
			{ kind: "media" as const, items: mediaItems },
			{ kind: "voice" as const, items: voiceItems },
			{ kind: "sandbox" as const, items: sandboxItems },
		].filter((g) => g.items.length > 0);
	}, [textEngines, voiceEngines, sandboxBackends, debouncedQuery]);

	if (error && groups.length === 0 && !loading) {
		return <EnginesErrorState message={error} />;
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
			detailTitle={selectedName ?? "Engine"}
			hasSelection={selectedId != null}
			list={
				<EngineList
					error={error}
					groups={groups}
					loading={loading}
					onSelect={setSelectedId}
					selectedId={selectedId}
				/>
			}
			onCloseDetail={() => setSelectedId(null)}
			search={{
				value: query,
				onChange: setQuery,
				placeholder: "Search engines…",
			}}
		/>
	);
}
