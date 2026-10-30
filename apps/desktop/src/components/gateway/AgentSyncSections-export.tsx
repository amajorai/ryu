import { FolderOpenIcon, Upload01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { useCallback, useState } from "react";
import { CaptionInfo } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import {
	type AgentSyncExportResult,
	type AgentSyncProfile,
	type AgentSyncResumeResult,
	type AgentSyncStatus,
	exportAgentSyncBundle,
	resolveAgentSyncConflict,
	resumeAgentSyncAcpSession,
} from "@/src/lib/api/agent-sync.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	profileIncludesConversations,
	useAgentSyncProfiles,
} from "./AgentSyncSections-profiles.ts";
import {
	ConflictList,
	LoadErrorRow,
	ProfileList,
	ProofRow,
	SyncStatusSection,
} from "./AgentSyncSections-rows.tsx";

export function AgentSyncExportSection({ target }: { target: ApiTarget }) {
	const {
		error: profileError,
		loading,
		profiles,
		refresh,
		save,
		status,
	} = useAgentSyncProfiles(target);
	const tl = useLiteralMessages();
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
				tl(
					"{loaded} ACP sessions loaded/resumed, {replays} transcript replays.",
					{ loaded, replays: results.length - loaded }
				)
			);
		} catch (cause) {
			setMessage(
				cause instanceof Error ? cause.message : "ACP resume probe failed"
			);
		} finally {
			setWorking(false);
		}
	}, [status, target, tl]);

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
		<div className="flex flex-col gap-8 [&>*]:mt-0">
			<SettingsSection
				caption={
					<CaptionInfo
						detail={
							"Ryu never fabricates Claude, Codex, or Cursor transcript files."
						}
					>
						{"Writes one versioned bundle to the destination you choose."}
					</CaptionInfo>
				}
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
							<label className="flex cursor-pointer items-center gap-2">
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
							<label className="flex cursor-pointer items-center gap-2">
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
							<label className="flex cursor-pointer items-center gap-2">
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
									variant="outline"
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
				caption={
					<CaptionInfo
						detail={
							"Native setup projections are limited to supported, explicitly selected formats. Automatic exports include conversation transcripts only when you tick them for that destination."
						}
					>
						{"Pick a profile to save export automation for that destination."}
					</CaptionInfo>
				}
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
