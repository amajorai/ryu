import {
	Download01Icon,
	FolderOpenIcon,
	RefreshIcon,
	Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { SettingsNavRow } from "@ryu/blocks/desktop/settings-nav.tsx";
import { SvglIcon, type SvglSpec } from "@ryu/blocks/web/svgl-icon.tsx";
import { Badge } from "@ryu/ui/components/badge.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentSyncExportResult,
	type AgentSyncImportResult,
	type AgentSyncProfile,
	type AgentSyncResumeResult,
	type AgentSyncScan,
	type AgentSyncScanItem,
	type AgentSyncStatus,
	exportAgentSyncBundle,
	getAgentSyncStatus,
	importAgentSyncItems,
	importAgentSyncThread,
	listAgentSyncProfiles,
	resolveAgentSyncConflict,
	resumeAgentSyncAcpSession,
	type SyncProvider,
	saveAgentSyncProfile,
	scanAgentSyncRoot,
} from "@/src/lib/api/agent-sync.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ImportSelection } from "@/src/lib/api/import.ts";
import { listDirectory } from "@/src/lib/api/workspace.ts";

interface ProviderOption {
	/** Home folder under `~` offered as a one-click scan; absent when the
	    source has no fixed home (an export download or a code project). */
	home?: string;
	label: string;
	/** Bundled brand mark (`/logos/<slug>.svg`). */
	logo: SvglSpec;
	value: SyncProvider;
}

const PROVIDERS: ProviderOption[] = [
	{ label: "Claude", value: "claude", home: ".claude", logo: "claude" },
	{ label: "Codex", value: "codex", home: ".codex", logo: "codex" },
	{
		label: "Cursor",
		value: "cursor",
		home: ".cursor",
		logo: { light: "cursor_light", dark: "cursor_dark" },
	},
	{ label: "OpenClaw", value: "openclaw", home: ".openclaw", logo: "openclaw" },
	{
		label: "Hermes",
		value: "hermes",
		home: ".hermes",
		logo: { light: "hermes_light", dark: "hermes_dark" },
	},
	{
		label: "ChatGPT",
		value: "chatgpt",
		logo: { light: "openai", dark: "openai_dark" },
	},
	{ label: "Claude.ai", value: "claude-ai", logo: "claude" },
	{ label: "Muse", value: "muse", logo: "meta" },
	{
		label: "Dots",
		value: "persona",
		logo: { light: "openai", dark: "openai_dark" },
	},
	{
		label: "Mastra",
		value: "mastra",
		logo: { light: "mastra_light", dark: "mastra_dark" },
	},
	{ label: "LangChain", value: "langchain", logo: "langchain" },
];

/** Providers with a well-known home folder, offered as one-click scans. */
const HOME_PROVIDERS = PROVIDERS.filter(
	(entry): entry is ProviderOption & { home: string } =>
		entry.home !== undefined
);

/** Where to point the root path for providers without a home folder. */
const PROVIDER_ROOT_HINTS = new Map<SyncProvider, string>([
	["chatgpt", "/Users/you/Downloads/chatgpt-export"],
	["claude-ai", "/Users/you/Downloads/claude-export"],
	["muse", "/Users/you/Downloads/muse-export"],
	["persona", "/Users/you/my-dot"],
	["mastra", "/Users/you/code/mastra-app"],
	["langchain", "/Users/you/code/langgraph-app"],
]);

interface ProfileDraft {
	exportEnabled: boolean;
	id?: string;
	importEnabled: boolean;
	/** Omitted keeps the stored choice; a new profile starts without transcripts. */
	includeConversations?: boolean;
	provider: SyncProvider;
	root: string;
}

/** Profiles carry `includeConversations` from Core; older Cores omit it (off). */
function profileIncludesConversations(profile: AgentSyncProfile): boolean {
	return (
		(profile as AgentSyncProfile & { includeConversations?: unknown })
			.includeConversations === true
	);
}

function useAgentSyncProfiles(target: ApiTarget) {
	const [profiles, setProfiles] = useState<AgentSyncProfile[]>([]);
	const [status, setStatus] = useState<AgentSyncStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const [profileResult, statusResult] = await Promise.all([
				listAgentSyncProfiles(target),
				getAgentSyncStatus(target),
			]);
			setProfiles(profileResult.profiles);
			setStatus(statusResult);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not load sync state"
			);
		} finally {
			setLoading(false);
		}
	}, [target]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const save = useCallback(
		async (draft: ProfileDraft) => {
			const saved = await saveAgentSyncProfile(target, draft);
			setProfiles((current) => {
				const next = current.filter((profile) => profile.id !== saved.id);
				return [...next, saved].sort((a, b) => a.root.localeCompare(b.root));
			});
			return saved;
		},
		[target]
	);

	return { error, loading, profiles, refresh, save, status };
}

function providerLabel(provider: SyncProvider): string {
	return PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;
}

function pathSeparator(path: string): string {
	return path.includes("\\") ? "\\" : "/";
}

function profileKey(profile: AgentSyncProfile): string {
	return `${profile.provider}:${profile.root}`;
}

/** One muted sentence inside a card: the shared empty state for these lists. */
function EmptyCard({ children }: { children: ReactNode }) {
	return (
		<SettingsCard className="text-center text-muted-foreground text-sm">
			{children}
		</SettingsCard>
	);
}

/**
 * A load failure as a plain sentence with Retry beside it. The raw message (an
 * HTTP status, a schema issue list) stays available under "Details" instead of
 * being the headline. The alert wraps the button so assistive tech announces
 * the failure together with its recovery.
 */
function LoadErrorRow({
	detail,
	loading,
	onRetry,
	summary,
}: {
	detail: string;
	loading: boolean;
	onRetry: () => void;
	summary: string;
}) {
	return (
		<div role="alert">
			<SettingsItem
				actions={
					<Button
						disabled={loading}
						onClick={onRetry}
						size="sm"
						variant="outline"
					>
						Retry
					</Button>
				}
				title={summary}
			>
				<details className="text-muted-foreground text-xs">
					<summary className="cursor-pointer select-none">Details</summary>
					<span className="mt-1 block break-all font-mono">{detail}</span>
				</details>
			</SettingsItem>
		</div>
	);
}

function ProfileList({
	profiles,
	selectedId,
	onSelect,
	onToggle,
}: {
	onSelect: (profile: AgentSyncProfile) => void;
	onToggle: (
		profile: AgentSyncProfile,
		key: "exportEnabled" | "importEnabled",
		value: boolean
	) => void;
	profiles: AgentSyncProfile[];
	selectedId: string | null;
}) {
	if (profiles.length === 0) {
		return (
			<EmptyCard>
				No sync roots configured yet. Save a scanned folder to add one.
			</EmptyCard>
		);
	}
	return (
		<SettingsGroup>
			{profiles.map((profile) => {
				const label = providerLabel(profile.provider);
				return (
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center gap-2">
								<Badge
									variant={
										profile.conflictCount > 0 ? "destructive" : "secondary"
									}
								>
									{profile.conflictCount > 0
										? `${profile.conflictCount} conflicts`
										: profile.status}
								</Badge>
								<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
									<span>Import</span>
									<Switch
										aria-label={`Enable import for ${label}`}
										checked={profile.importEnabled}
										onCheckedChange={(checked) =>
											onToggle(profile, "importEnabled", checked)
										}
									/>
									<span>Export</span>
									<Switch
										aria-label={`Enable export for ${label}`}
										checked={profile.exportEnabled}
										onCheckedChange={(checked) =>
											onToggle(profile, "exportEnabled", checked)
										}
									/>
								</div>
								<Button
									onClick={() => onSelect(profile)}
									size="sm"
									variant="outline"
								>
									Use
								</Button>
							</div>
						}
						key={profileKey(profile)}
						title={profile.id === selectedId ? `${label} · selected` : label}
					>
						<span
							className="block truncate font-mono text-muted-foreground text-xs"
							title={profile.root}
						>
							{profile.root}
						</span>
					</SettingsItem>
				);
			})}
		</SettingsGroup>
	);
}

function RootDetection({
	home,
	homeError,
	homeLoading,
	onScan,
	onRetry,
	detected,
}: {
	detected: Set<string>;
	homeError: string | null;
	homeLoading: boolean;
	home: string | null;
	onScan: (path: string, provider: SyncProvider) => void;
	onRetry: () => void;
}) {
	if (!home) {
		if (homeError) {
			return (
				<LoadErrorRow
					detail={homeError}
					loading={homeLoading}
					onRetry={onRetry}
					summary="Couldn’t find this node’s home directory."
				/>
			);
		}
		return (
			<div role="status">
				<SettingsItem
					actions={homeLoading ? <Spinner className="size-4" /> : null}
					title="Detecting this node’s home directory…"
				/>
			</div>
		);
	}
	const separator = pathSeparator(home);
	return (
		<SettingsGroup>
			{HOME_PROVIDERS.map((provider) => {
				const path = `${home}${separator}${provider.home}`;
				return (
					<SettingsNavRow
						key={provider.value}
						onClick={() => onScan(path, provider.value)}
						title={
							<span className="flex items-center gap-2.5">
								<SvglIcon size={18} spec={provider.logo} />
								{provider.label}
							</span>
						}
						value={
							<Badge variant={detected.has(path) ? "default" : "secondary"}>
								{detected.has(path) ? "detected" : "scan"}
							</Badge>
						}
					/>
				);
			})}
		</SettingsGroup>
	);
}

/** A scrolling checklist inside one card; rows are plain labels, no inner box. */
function ChecklistCard({ children }: { children: ReactNode }) {
	return (
		<SettingsCard className="max-h-72 overflow-y-auto p-1.5">
			{children}
		</SettingsCard>
	);
}

function ScanItems({
	items,
	selected,
	onToggle,
}: {
	items: AgentSyncScanItem[];
	onToggle: (item: AgentSyncScanItem, checked: boolean) => void;
	selected: Set<string>;
}) {
	if (items.length === 0) {
		return <EmptyCard>No supported setup items found.</EmptyCard>;
	}
	return (
		<ChecklistCard>
			{items.map((item) => {
				const key = `${item.kind}:${item.id}`;
				return (
					<label
						className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
						key={key}
					>
						<Checkbox
							checked={selected.has(key)}
							onCheckedChange={(checked) => onToggle(item, checked === true)}
						/>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-sm" title={item.title}>
								{item.title}
							</span>
							<span className="block truncate font-mono text-muted-foreground text-xs">
								{item.kind} · {item.id}
							</span>
						</span>
						{item.already_exists ? (
							<Badge variant="secondary">present</Badge>
						) : null}
					</label>
				);
			})}
		</ChecklistCard>
	);
}

function ThreadItems({
	items,
	onToggle,
	selected,
}: {
	items: AgentSyncScan["threads"];
	onToggle: (id: string, checked: boolean) => void;
	selected: Set<string>;
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<ChecklistCard>
			{items.map((thread) => (
				<label
					className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-foreground/5"
					key={thread.id}
				>
					<Checkbox
						checked={selected.has(thread.id)}
						onCheckedChange={(checked) => onToggle(thread.id, checked === true)}
					/>
					<span className="min-w-0 flex-1">
						<span className="block truncate text-sm" title={thread.title}>
							{thread.title}
						</span>
						<span className="block truncate font-mono text-muted-foreground text-xs">
							{thread.native_session_id ?? thread.id} · {thread.message_count}{" "}
							messages
						</span>
					</span>
				</label>
			))}
		</ChecklistCard>
	);
}

function MutedValue({ children }: { children: ReactNode }) {
	return <span className="text-muted-foreground text-sm">{children}</span>;
}

function SyncStatusSection({ status }: { status: AgentSyncStatus | null }) {
	if (!status) {
		return null;
	}
	return (
		<SettingsSection title="Status">
			<SettingsGroup>
				<SettingsItem
					actions={
						<MutedValue>
							{formatCount(status.profiles.length) ?? "—"}
						</MutedValue>
					}
					title="Profiles"
				/>
				<SettingsItem
					actions={
						<MutedValue>
							{formatCount(status.bindings.length) ?? "—"}
						</MutedValue>
					}
					title="ACP bindings"
				/>
				<SettingsItem
					actions={
						<MutedValue>
							{formatCount(status.activeOperations) ?? "—"}
						</MutedValue>
					}
					title="Active operations"
				/>
				<SettingsItem
					actions={
						<span className="font-mono text-muted-foreground text-xs">
							{status.nodeId}
						</span>
					}
					title="Node"
				/>
			</SettingsGroup>
		</SettingsSection>
	);
}

/** A proof record row: label on top, the (often long, monospace) value beneath. */
function ProofRow({ title, value }: { title: string; value: string }) {
	return (
		<SettingsItem title={title}>
			<span className="block break-all text-muted-foreground text-xs">
				{value}
			</span>
		</SettingsItem>
	);
}

function ConflictList({
	onResolve,
	status,
}: {
	onResolve: (
		item: AgentSyncStatus["items"][number],
		resolution: "keep_external" | "keep_ryu"
	) => void;
	status: AgentSyncStatus | null;
}) {
	const conflicts =
		status?.items.filter((item) => item.state === "conflict") ?? [];
	if (conflicts.length === 0) {
		return <EmptyCard>No conflicts.</EmptyCard>;
	}
	return (
		<>
			<p className="px-3.5 text-status-warning text-xs leading-snug">
				External changes are paused until reviewed.
			</p>
			<SettingsGroup>
				{conflicts.map((item) => (
					<SettingsItem
						actions={
							<div className="flex gap-2">
								<Button
									onClick={() => onResolve(item, "keep_external")}
									size="sm"
									variant="outline"
								>
									Keep external
								</Button>
								<Button onClick={() => onResolve(item, "keep_ryu")} size="sm">
									Keep Ryu
								</Button>
							</div>
						}
						key={`${item.profileId}:${item.kind}:${item.sourceId}`}
						title="Conflict paused"
					>
						<span className="block truncate font-mono text-muted-foreground text-xs">
							{`${item.kind} · ${item.sourceId} · revision ${item.revision}`}
						</span>
					</SettingsItem>
				))}
			</SettingsGroup>
		</>
	);
}

export function AgentSyncImportSection({ target }: { target: ApiTarget }) {
	const {
		error: profileError,
		loading,
		profiles,
		refresh,
		save,
		status,
	} = useAgentSyncProfiles(target);
	const [home, setHome] = useState<string | null>(null);
	const [homeError, setHomeError] = useState<string | null>(null);
	const [homeLoading, setHomeLoading] = useState(true);
	const [homeRetry, setHomeRetry] = useState(0);
	const [detected, setDetected] = useState<Set<string>>(new Set());
	const [selectedProfile, setSelectedProfile] =
		useState<AgentSyncProfile | null>(null);
	const [provider, setProvider] = useState<SyncProvider>("claude");
	const [root, setRoot] = useState("");
	const [scan, setScan] = useState<AgentSyncScan | null>(null);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [selectedThreads, setSelectedThreads] = useState<Set<string>>(
		new Set()
	);
	const [importResult, setImportResult] =
		useState<AgentSyncImportResult | null>(null);
	const [working, setWorking] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		async function loadDetectedRoots() {
			setHomeLoading(true);
			setHomeError(null);
			try {
				const listing = await listDirectory(target);
				if (cancelled) {
					return;
				}
				setHome(listing.home);
				const separator = pathSeparator(listing.home);
				const candidates = HOME_PROVIDERS.map((entry) => ({
					path: `${listing.home}${separator}${entry.home}`,
					provider: entry.value,
				}));
				const results = await Promise.allSettled(
					candidates.map((candidate) =>
						scanAgentSyncRoot(target, candidate.path, candidate.provider)
					)
				);
				if (cancelled) {
					return;
				}
				setDetected(
					new Set(
						results.flatMap((result, index) =>
							result.status === "fulfilled" ? [candidates[index].path] : []
						)
					)
				);
			} catch (cause) {
				if (!cancelled) {
					setHome(null);
					setHomeError(
						cause instanceof Error
							? cause.message
							: "Could not load this node’s home directory"
					);
				}
			} finally {
				if (!cancelled) {
					setHomeLoading(false);
				}
			}
		}
		void loadDetectedRoots();
		return () => {
			cancelled = true;
		};
	}, [homeRetry, target]);

	const onScan = useCallback(
		async (path: string, nextProvider: SyncProvider) => {
			setWorking(true);
			setMessage(null);
			setProvider(nextProvider);
			setRoot(path);
			try {
				const result = await scanAgentSyncRoot(target, path, nextProvider);
				setScan(result);
				setSelected(
					new Set(result.items.map((item) => `${item.kind}:${item.id}`))
				);
				setSelectedThreads(new Set(result.threads.map((thread) => thread.id)));
				setDetected((current) => new Set([...current, path]));
			} catch (cause) {
				setScan(null);
				setMessage(cause instanceof Error ? cause.message : "Scan failed");
			} finally {
				setWorking(false);
			}
		},
		[target]
	);

	const saveCurrentProfile = useCallback(
		async (overrides: Partial<ProfileDraft> = {}) => {
			if (!root.trim()) {
				throw new Error("Choose an agent root first");
			}
			const saved = await save({
				exportEnabled: selectedProfile?.exportEnabled ?? false,
				importEnabled: selectedProfile?.importEnabled ?? true,
				id: selectedProfile?.id,
				provider,
				root,
				...overrides,
			});
			setSelectedProfile(saved);
			return saved;
		},
		[provider, root, save, selectedProfile]
	);

	const toggleProfile = useCallback(
		async (
			profile: AgentSyncProfile,
			key: "exportEnabled" | "importEnabled",
			value: boolean
		) => {
			try {
				const saved = await save({
					exportEnabled:
						key === "exportEnabled" ? value : profile.exportEnabled,
					importEnabled:
						key === "importEnabled" ? value : profile.importEnabled,
					id: profile.id,
					provider: profile.provider,
					root: profile.root,
				});
				setSelectedProfile((current) =>
					current?.id === saved.id ? saved : current
				);
			} catch (cause) {
				setMessage(
					cause instanceof Error ? cause.message : "Could not update profile"
				);
			}
		},
		[save]
	);

	const saveRoot = useCallback(async () => {
		setMessage(null);
		try {
			await saveCurrentProfile({ importEnabled: true });
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "Could not save sync root"
			);
		}
	}, [saveCurrentProfile]);

	const selectedItems = useMemo<ImportSelection[]>(
		() =>
			(scan?.items ?? [])
				.filter((item) => selected.has(`${item.kind}:${item.id}`))
				.map((item) => ({ id: item.id, kind: item.kind })),
		[scan, selected]
	);

	const runImport = useCallback(
		async (dryRun: boolean) => {
			setWorking(true);
			setMessage(null);
			try {
				const profile = selectedProfile ?? (await saveCurrentProfile());
				const result = await importAgentSyncItems(target, {
					dryRun,
					items: selectedItems,
					path: root,
					profileId: profile.id,
				});
				setImportResult(result);
				setMessage(
					`${dryRun ? "Preview" : "Import"} ${result.operationId}: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed.`
				);
				await refresh();
			} catch (cause) {
				setMessage(cause instanceof Error ? cause.message : "Import failed");
			} finally {
				setWorking(false);
			}
		},
		[refresh, root, saveCurrentProfile, selectedItems, selectedProfile, target]
	);

	const runThreadImport = useCallback(async () => {
		if (!scan?.agentId || selectedThreads.size === 0) {
			return;
		}
		setWorking(true);
		setMessage(null);
		try {
			let added = 0;
			let alreadyImported = 0;
			for (const thread of scan.threads) {
				if (!selectedThreads.has(thread.id)) {
					continue;
				}
				const result = await importAgentSyncThread(target, {
					agentId: scan.agentId,
					threadId: thread.id,
				});
				added += result.messagesAdded;
				if (result.alreadyImported) {
					alreadyImported += 1;
				}
			}
			setMessage(
				`Native thread import complete: ${added} messages added, ${alreadyImported} already linked.`
			);
			await refresh();
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "Native thread import failed"
			);
		} finally {
			setWorking(false);
		}
	}, [refresh, scan, selectedThreads, target]);

	const toggleSelectedItem = (item: AgentSyncScanItem, checked: boolean) => {
		const key = `${item.kind}:${item.id}`;
		setSelected((current) => {
			const next = new Set(current);
			if (checked) {
				next.add(key);
			} else {
				next.delete(key);
			}
			return next;
		});
	};

	const toggleSelectedThread = (id: string, checked: boolean) => {
		setSelectedThreads((current) => {
			const next = new Set(current);
			if (checked) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});
	};

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Ryu reads Claude, Codex, Cursor, OpenClaw, and Hermes homes, a ChatGPT or Claude data export, a Muse download, a Dots folder, or a Mastra or LangChain project without changing them. Automatic import is off until you enable it for a saved root."
				title="Import agent setup"
			>
				<RootDetection
					detected={detected}
					home={home}
					homeError={homeError}
					homeLoading={homeLoading}
					onRetry={() => setHomeRetry((attempt) => attempt + 1)}
					onScan={onScan}
				/>
			</SettingsSection>

			<SettingsSection title="Scan a folder">
				<SettingsGroup>
					<SettingsItem
						actions={
							<Input
								id="agent-sync-import-root"
								onChange={(event) => setRoot(event.target.value)}
								placeholder={
									PROVIDER_ROOT_HINTS.get(provider) ??
									`/Users/you/${PROVIDERS.find((entry) => entry.value === provider)?.home ?? ".claude"}`
								}
								value={root}
							/>
						}
						title={
							<Label className="font-normal" htmlFor="agent-sync-import-root">
								Root path
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<select
								aria-label="Agent provider"
								className="h-8 rounded-md border border-input bg-background px-2 text-sm"
								id="agent-sync-import-provider"
								onChange={(event) =>
									setProvider(
										/* SAFETY: This authored select renders only PROVIDERS values, whose owner type is SyncProvider. This is a native UI selection, not a decoder for arbitrary synthetic events. */ event
											.target.value as SyncProvider
									)
								}
								value={provider}
							>
								{PROVIDERS.map((entry) => (
									<option key={entry.value} value={entry.value}>
										{entry.label}
									</option>
								))}
							</select>
						}
						title={
							<Label
								className="font-normal"
								htmlFor="agent-sync-import-provider"
							>
								Agent
							</Label>
						}
					/>
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center gap-2">
								{working ? <Spinner className="size-4" /> : null}
								<Button
									disabled={working || !root.trim()}
									onClick={() => void saveRoot()}
									size="sm"
									variant="outline"
								>
									Save root + enable import
								</Button>
								<Button
									disabled={working || !root.trim()}
									onClick={() => onScan(root, provider)}
									size="sm"
								>
									<HugeiconsIcon className="size-4" icon={RefreshIcon} />
									Scan
								</Button>
							</div>
						}
						description={
							message ? <span role="status">{message}</span> : undefined
						}
						title={
							selectedProfile ? (
								<Badge variant="secondary">profile {selectedProfile.id}</Badge>
							) : (
								"Not saved yet"
							)
						}
					/>
				</SettingsGroup>
			</SettingsSection>

			{scan ? (
				<>
					<SettingsSection
						caption={`${scan.items.length} setup items and ${scan.threads.length} native threads detected. Unsupported native history stays bundle-only.`}
						title="Import preview"
					>
						<SettingsItem
							actions={
								<div className="flex flex-wrap justify-end gap-2">
									<Badge variant="secondary">{scan.provider}</Badge>
									<Badge
										variant={
											scan.capabilities.nativeThreads ? "default" : "secondary"
										}
									>
										{scan.capabilities.nativeThreads
											? "native threads readable"
											: "bundle-only threads"}
									</Badge>
									<Badge variant="secondary">
										ACP{" "}
										{scan.capabilities.acpLoadResume === true
											? "resume"
											: "replay fallback"}
									</Badge>
								</div>
							}
							title="Source"
						/>
					</SettingsSection>

					<SettingsSection
						headerAction={
							<div className="flex gap-2">
								<Button
									disabled={working || selectedItems.length === 0}
									onClick={() => void runImport(true)}
									size="sm"
									variant="outline"
								>
									Preview selected
								</Button>
								<Button
									disabled={working || selectedItems.length === 0}
									onClick={() => void runImport(false)}
									size="sm"
								>
									<HugeiconsIcon className="size-4" icon={Download01Icon} />
									Import selected
								</Button>
							</div>
						}
						title="Setup items"
					>
						<ScanItems
							items={scan.items}
							onToggle={toggleSelectedItem}
							selected={selected}
						/>
					</SettingsSection>

					{scan.threads.length > 0 ? (
						<SettingsSection
							headerAction={
								<Button
									disabled={
										working || !scan.agentId || selectedThreads.size === 0
									}
									onClick={() => void runThreadImport()}
									size="sm"
									variant="outline"
								>
									Import selected threads
								</Button>
							}
							title="Native threads"
						>
							<SettingsItem
								actions={
									<Badge variant={scan.agentId ? "default" : "secondary"}>
										{scan.agentId ? "ACP-backed import" : "agent unavailable"}
									</Badge>
								}
								title="Import path"
							/>
							<ThreadItems
								items={scan.threads}
								onToggle={toggleSelectedThread}
								selected={selectedThreads}
							/>
						</SettingsSection>
					) : null}

					{scan.warnings.length > 0 ? (
						<SettingsSection title="Review before cutover">
							<SettingsCard className="flex flex-col gap-1.5">
								{scan.warnings.map((warning) => (
									<p className="text-sm text-status-warning" key={warning}>
										{warning}
									</p>
								))}
							</SettingsCard>
						</SettingsSection>
					) : null}
				</>
			) : null}

			{importResult ? (
				<SettingsSection
					caption="In-app proof of the last import operation."
					title="Sync proof"
				>
					<SettingsGroup>
						<ProofRow
							title="Profiles and bindings"
							value={`${status?.profiles.length ?? 0} profiles · ${status?.bindings.length ?? 0} ACP bindings`}
						/>
						<ProofRow title="Operation ID" value={importResult.operationId} />
						<ProofRow
							title="Imported counts"
							value={`${importResult.imported} imported · ${importResult.skipped} skipped · ${importResult.failed} failed`}
						/>
						<ProofRow
							title="Conflict count"
							value={`${importResult.conflicts} conflicts`}
						/>
						<ProofRow
							title="ACP resume versus replay"
							value={`${status?.bindings.filter((binding) => binding.capabilities && JSON.stringify(binding.capabilities).includes("loadSession")).length ?? 0} capability records · replay fallback remains available`}
						/>
					</SettingsGroup>
				</SettingsSection>
			) : null}

			<SettingsSection
				caption="Import and export switches are independent per root. A generated bundle hash is recorded so retries never create duplicate Ryu items."
				title="Configured roots"
			>
				{loading ? (
					<SettingsCard>
						<SkeletonRows label="Loading sync roots…" />
					</SettingsCard>
				) : profileError ? (
					<LoadErrorRow
						detail={profileError}
						loading={loading}
						onRetry={() => void refresh()}
						summary="Couldn’t load sync roots."
					/>
				) : (
					<ProfileList
						onSelect={(profile) => {
							setSelectedProfile(profile);
							setProvider(profile.provider);
							setRoot(profile.root);
							setScan(null);
							setSelected(new Set());
							setSelectedThreads(new Set());
							setImportResult(null);
							setMessage(null);
						}}
						onToggle={toggleProfile}
						profiles={profiles}
						selectedId={selectedProfile?.id ?? null}
					/>
				)}
			</SettingsSection>

			<SyncStatusSection status={status} />
		</div>
	);
}

export function AgentSyncExportSection({ target }: { target: ApiTarget }) {
	const {
		error: profileError,
		loading,
		profiles,
		refresh,
		save,
		status,
	} = useAgentSyncProfiles(target);
	const [selectedProfile, setSelectedProfile] =
		useState<AgentSyncProfile | null>(null);
	const [destination, setDestination] = useState("");
	const [includeAgents, setIncludeAgents] = useState(true);
	const [includeSkills, setIncludeSkills] = useState(true);
	// Transcripts leave the encrypted data folder as plaintext: opt-in only.
	const [includeConversations, setIncludeConversations] = useState(false);
	const [working, setWorking] = useState(false);
	const [result, setResult] = useState<AgentSyncExportResult | null>(null);
	const [resumeResults, setResumeResults] = useState<AgentSyncResumeResult[]>(
		[]
	);
	const [message, setMessage] = useState<string | null>(null);

	const toggleProfile = useCallback(
		async (
			profile: AgentSyncProfile,
			key: "exportEnabled" | "importEnabled",
			value: boolean
		) => {
			try {
				const saved = await save({
					exportEnabled:
						key === "exportEnabled" ? value : profile.exportEnabled,
					importEnabled:
						key === "importEnabled" ? value : profile.importEnabled,
					id: profile.id,
					provider: profile.provider,
					root: profile.root,
				});
				setSelectedProfile((current) =>
					current?.id === saved.id ? saved : current
				);
			} catch (cause) {
				setMessage(
					cause instanceof Error ? cause.message : "Could not update profile"
				);
			}
		},
		[save]
	);

	const changeIncludeConversations = useCallback(
		async (value: boolean) => {
			setIncludeConversations(value);
			if (!selectedProfile) {
				return;
			}
			// Persist the choice on the selected destination so automatic
			// exports follow it.
			try {
				const saved = await save({
					exportEnabled: selectedProfile.exportEnabled,
					id: selectedProfile.id,
					importEnabled: selectedProfile.importEnabled,
					includeConversations: value,
					provider: selectedProfile.provider,
					root: selectedProfile.root,
				});
				setSelectedProfile(saved);
			} catch (cause) {
				setMessage(
					cause instanceof Error ? cause.message : "Could not update profile"
				);
			}
		},
		[save, selectedProfile]
	);

	const runExport = useCallback(
		async (dryRun: boolean) => {
			setWorking(true);
			setMessage(null);
			try {
				if (!destination.trim()) {
					throw new Error("Choose an explicit destination folder");
				}
				const exportResult = await exportAgentSyncBundle(target, {
					destination,
					dryRun,
					includeAgents,
					includeConversations,
					includeSkills,
					profileId: selectedProfile?.id,
				});
				setResult(exportResult);
				setMessage(
					`${dryRun ? "Preview" : "Export"} ${exportResult.operationId} · ${exportResult.bundleHash}`
				);
				await refresh();
			} catch (cause) {
				setMessage(cause instanceof Error ? cause.message : "Export failed");
			} finally {
				setWorking(false);
			}
		},
		[
			destination,
			includeAgents,
			includeConversations,
			includeSkills,
			refresh,
			selectedProfile,
			target,
		]
	);

	const runAcpResume = useCallback(async () => {
		if (!status || status.bindings.length === 0) {
			return;
		}
		setWorking(true);
		setMessage(null);
		try {
			const results: AgentSyncResumeResult[] = [];
			for (const binding of status.bindings) {
				results.push(
					await resumeAgentSyncAcpSession(target, binding.conversationId)
				);
			}
			setResumeResults(results);
			const loaded = results.filter((entry) => entry.mode !== "replay").length;
			setMessage(
				`${loaded} ACP sessions loaded/resumed, ${results.length - loaded} transcript replays.`
			);
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "ACP resume probe failed"
			);
		} finally {
			setWorking(false);
		}
	}, [status, target]);

	const resolveConflict = useCallback(
		async (
			item: AgentSyncStatus["items"][number],
			resolution: "keep_external" | "keep_ryu"
		) => {
			try {
				await resolveAgentSyncConflict(target, {
					itemId: item.sourceId,
					kind: item.kind,
					profileId: item.profileId,
					resolution,
				});
				await refresh();
			} catch (cause) {
				setMessage(
					cause instanceof Error ? cause.message : "Could not resolve conflict"
				);
			}
		},
		[refresh, target]
	);

	return (
		<div className="flex flex-col gap-6">
			<SettingsSection
				caption="Export is opt-in and writes one versioned portable bundle to the destination you choose. Ryu never fabricates Claude, Codex, or Cursor transcript files."
				title="Export Ryu data"
			>
				<SettingsGroup>
					<SettingsItem
						actions={
							<Button
								disabled={!selectedProfile}
								onClick={() => setDestination(selectedProfile?.root ?? "")}
								size="sm"
								variant="outline"
							>
								<HugeiconsIcon className="size-4" icon={FolderOpenIcon} />
								Use selected root
							</Button>
						}
						title={
							<Label
								className="font-normal"
								htmlFor="agent-sync-export-destination"
							>
								Destination folder
							</Label>
						}
					>
						<Input
							id="agent-sync-export-destination"
							onChange={(event) => setDestination(event.target.value)}
							placeholder="/Users/you/.claude"
							value={destination}
						/>
					</SettingsItem>
					<SettingsItem
						title={
							<label className="flex cursor-pointer items-center gap-2.5">
								<Checkbox
									checked={includeAgents}
									onCheckedChange={(checked) =>
										setIncludeAgents(checked === true)
									}
								/>
								Agent definitions
							</label>
						}
					/>
					<SettingsItem
						description={
							includeConversations ? (
								<span role="note">
									Conversation transcripts are written in plain text to the
									destination folder, outside Ryu's encrypted data folder.
									Anyone or any tool that can read that folder can read them.
								</span>
							) : undefined
						}
						title={
							<label className="flex cursor-pointer items-center gap-2.5">
								<Checkbox
									checked={includeConversations}
									onCheckedChange={(checked) =>
										void changeIncludeConversations(checked === true)
									}
								/>
								Conversation transcripts
							</label>
						}
					/>
					<SettingsItem
						title={
							<label className="flex cursor-pointer items-center gap-2.5">
								<Checkbox
									checked={includeSkills}
									onCheckedChange={(checked) =>
										setIncludeSkills(checked === true)
									}
								/>
								Agent Skills
							</label>
						}
					/>
					<SettingsItem
						actions={
							<div className="flex flex-wrap items-center gap-2">
								{working ? <Spinner className="size-4" /> : null}
								<Button
									disabled={working || !destination.trim()}
									onClick={() => void runExport(true)}
									size="sm"
									variant="outline"
								>
									Preview bundle
								</Button>
								<Button
									disabled={working || !destination.trim()}
									onClick={() => void runExport(false)}
									size="sm"
								>
									<HugeiconsIcon className="size-4" icon={Upload01Icon} />
									Export bundle
								</Button>
							</div>
						}
						title="Bundle"
					/>
					<SettingsItem
						actions={
							<Button
								disabled={working || (status?.bindings.length ?? 0) === 0}
								onClick={() => void runAcpResume()}
								size="sm"
								variant="outline"
							>
								Test ACP resume/load
							</Button>
						}
						description={message ?? undefined}
						title="ACP sessions"
					/>
				</SettingsGroup>
			</SettingsSection>

			<SettingsSection
				caption="Select a profile to persist export automation for that destination. Native setup projections are limited to supported, explicitly selected formats. Automatic exports include conversation transcripts only when you tick them for that destination."
				title="Export destinations"
			>
				{loading ? (
					<SettingsCard>
						<SkeletonRows label="Loading sync roots…" />
					</SettingsCard>
				) : profileError ? (
					<LoadErrorRow
						detail={profileError}
						loading={loading}
						onRetry={() => void refresh()}
						summary="Couldn’t load sync roots."
					/>
				) : (
					<ProfileList
						onSelect={(profile) => {
							setSelectedProfile(profile);
							setDestination(profile.root);
							setIncludeConversations(profileIncludesConversations(profile));
						}}
						onToggle={toggleProfile}
						profiles={profiles}
						selectedId={selectedProfile?.id ?? null}
					/>
				)}
			</SettingsSection>

			{result ? (
				<SettingsSection
					caption="This is the in-app verification record for the last operation."
					title="Sync proof"
				>
					<SettingsGroup>
						<ProofRow title="Operation ID" value={result.operationId} />
						<ProofRow title="Bundle SHA-256" value={result.bundleHash} />
						<ProofRow
							title="Projected counts"
							value={`${result.agents} agents · ${result.skills} skills · ${result.conversations} conversations · ${result.messages} messages`}
						/>
						<ProofRow
							title="ACP persistence"
							value={`${result.acpResume.filter((entry) => entry.mode !== "replay").length} ACP loads/resumes · ${result.acpResume.filter((entry) => entry.mode === "replay").length} transcript replays`}
						/>
						<ProofRow title="Bundle path" value={result.bundlePath} />
						<ProofRow
							title="Safety result"
							value={`${result.conflicts} conflicts · ${result.projectedFiles} files written`}
						/>
						{resumeResults.length > 0 ? (
							<ProofRow
								title="ACP resume proof"
								value={`${resumeResults.filter((entry) => entry.mode !== "replay").length} load/resume · ${resumeResults.filter((entry) => entry.mode === "replay").length} replay fallback`}
							/>
						) : null}
					</SettingsGroup>
				</SettingsSection>
			) : null}

			<SettingsSection
				caption="Ryu preserves conflicting output until you make an explicit choice."
				title="Conflicts"
			>
				<ConflictList
					onResolve={(item, resolution) =>
						void resolveConflict(item, resolution)
					}
					status={status}
				/>
			</SettingsSection>

			<SyncStatusSection status={status} />
		</div>
	);
}
