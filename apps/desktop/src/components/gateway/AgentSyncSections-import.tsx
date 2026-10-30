import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useMemo, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentSyncImportResult,
	type AgentSyncProfile,
	type AgentSyncScan,
	type AgentSyncScanItem,
	importAgentSyncItems,
	importAgentSyncThread,
	type SyncProvider,
	scanAgentSyncRoot,
} from "@/src/lib/api/agent-sync.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import type { ImportSelection } from "@/src/lib/api/import.ts";
import { useDetectedAgentRoots } from "./AgentSyncSections-detected-roots.ts";
import { ImportScanPreview } from "./AgentSyncSections-import-preview.tsx";
import {
	type ProfileDraft,
	useAgentSyncProfiles,
} from "./AgentSyncSections-profiles.ts";
import {
	PROVIDER_ROOT_HINTS,
	PROVIDERS,
} from "./AgentSyncSections-providers.ts";
import {
	LoadErrorRow,
	ProfileList,
	ProofRow,
	SyncStatusSection,
} from "./AgentSyncSections-rows.tsx";
import { RootDetection } from "./AgentSyncSections-scan.tsx";

export function AgentSyncImportSection({ target }: { target: ApiTarget }) {
	const {
		error: profileError,
		loading,
		profiles,
		refresh,
		save,
		status,
	} = useAgentSyncProfiles(target);
	const tl = useLiteralMessages();
	const { detected, home, homeError, homeLoading, setDetected, setHomeRetry } =
		useDetectedAgentRoots(target);
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
				const counts = {
					failed: result.failed,
					imported: result.imported,
					operationId: result.operationId,
					skipped: result.skipped,
				};
				setMessage(
					dryRun
						? tl(
								"Preview {operationId}: {imported} imported, {skipped} skipped, {failed} failed.",
								counts
							)
						: tl(
								"Import {operationId}: {imported} imported, {skipped} skipped, {failed} failed.",
								counts
							)
				);
				await refresh();
			} catch (cause) {
				setMessage(cause instanceof Error ? cause.message : "Import failed");
			} finally {
				setWorking(false);
			}
		},
		[
			refresh,
			root,
			saveCurrentProfile,
			selectedItems,
			selectedProfile,
			target,
			tl,
		]
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
				tl(
					"Native thread import complete: {added} messages added, {alreadyImported} already linked.",
					{ added, alreadyImported }
				)
			);
			await refresh();
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "Native thread import failed"
			);
		} finally {
			setWorking(false);
		}
	}, [refresh, scan, selectedThreads, target, tl]);

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
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Ryu reads Claude, Codex, Cursor, OpenClaw, and Hermes homes, a ChatGPT or Claude data export, a Muse download, a Dots folder, or a Mastra or LangChain project without changing them. Automatic import is off until you enable it for a saved root."
						}
					>
						{"Reads other agents' homes and exports without changing them."}
					</CaptionInfo>
				}
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
								className="h-8 rounded-lg border-0 bg-muted/50 px-2 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
									variant="outline"
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
								<span>{tl("Profile {id}", { id: selectedProfile.id })}</span>
							) : (
								"Not saved yet"
							)
						}
					/>
				</SettingsGroup>
			</SettingsSection>

			{scan ? (
				<ImportScanPreview
					runImport={runImport}
					runThreadImport={runThreadImport}
					scan={scan}
					selected={selected}
					selectedItems={selectedItems}
					selectedThreads={selectedThreads}
					toggleSelectedItem={toggleSelectedItem}
					toggleSelectedThread={toggleSelectedThread}
					working={working}
				/>
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
				caption="Import and export are switched per root. Retries never duplicate items."
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
