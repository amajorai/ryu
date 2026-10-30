import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import type { Dispatch, SetStateAction } from "react";
import { Segmented } from "@/src/components/gateway/quiet.tsx";
import {
	SettingsCard,
	SettingsGroup,
	SettingsItem,
	SettingsSection,
} from "@/src/components/settings/shared/settings-items.tsx";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	type CloudEnvironment,
	type CloudEnvironmentsSnapshot,
	type CloudEnvironmentWrite,
	type CloudVaultEntry,
	type CloudVaultKind,
	fetchSharedCloudEnvironments,
	importSharedCloudEnvironment,
} from "@/src/lib/api/cloud-environments.ts";
import { errorMessage } from "./CloudEnvironmentsSettings-shared.ts";

export function CloudEnvironmentsFilters({
	tab,
	setTab,
	search,
	setSearch,
	vaultFilter,
	setVaultFilter,
}: {
	tab: "environments" | "vault";
	setTab: (tab: "environments" | "vault") => void;
	search: string;
	setSearch: (search: string) => void;
	vaultFilter: CloudVaultKind | "all";
	setVaultFilter: (filter: CloudVaultKind | "all") => void;
}) {
	return (
		<>
			{/* Segmented control above the list it switches, as in Apple's
				    Settings; the search field (and the vault's type filter) sit
				    directly under it. */}
			<Segmented
				className="w-full [&>*]:flex-1"
				label="Cloud environment view"
				onChange={setTab}
				options={[
					{ label: "Environments", value: "environments" },
					{ label: "Personal vault", value: "vault" },
				]}
				value={tab}
			/>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					aria-label="Search cloud environments and vault"
					className="min-w-36 flex-1"
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search"
					value={search}
				/>
				{tab === "vault" ? (
					<NativeSelect
						aria-label="Filter vault entry types"
						onChange={(event) =>
							setVaultFilter(
								event.target.value === "variable" ||
									event.target.value === "networkSecret"
									? event.target.value
									: "all"
							)
						}
						value={vaultFilter}
					>
						<NativeSelectOption value="all">All types</NativeSelectOption>
						<NativeSelectOption value="variable">
							Environment variables
						</NativeSelectOption>
						<NativeSelectOption value="networkSecret">
							Network secrets
						</NativeSelectOption>
					</NativeSelect>
				) : null}
			</div>
		</>
	);
}

export function CloudEnvironmentsList({
	tab,
	snapshot,
	busy,
	matchingEnvironments,
	matchingVault,
	tabEntries,
	tabMatches,
	setError,
	setEditing,
	runSetup,
	setEditingVault,
	setVaultOpen,
	setDeleting,
}: {
	tab: "environments" | "vault";
	snapshot: CloudEnvironmentsSnapshot | null;
	busy: boolean;
	matchingEnvironments: CloudEnvironment[];
	matchingVault: CloudVaultEntry[];
	tabEntries: CloudEnvironment[] | CloudVaultEntry[] | undefined;
	tabMatches: CloudEnvironment[] | CloudVaultEntry[];
	setError: (error: string | null) => void;
	setEditing: (environment: CloudEnvironment | null) => void;
	runSetup: (environment: CloudEnvironment) => Promise<void>;
	setEditingVault: (entry: CloudVaultEntry | null) => void;
	setVaultOpen: (open: boolean) => void;
	setDeleting: (entry: CloudVaultEntry | null) => void;
}) {
	const tl = useLiteralMessages();
	return (
		<>
			{snapshot && tabMatches.length > 0 ? (
				<SettingsGroup>
					{tab === "environments"
						? matchingEnvironments.map((item) => (
								<SettingsItem
									actions={
										<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
											<Button
												disabled={busy}
												onClick={() => {
													setError(null);
													setEditing(structuredClone(item));
												}}
												size="sm"
												variant="ghost"
											>
												Edit
											</Button>
											{item.published ? (
												<Button
													disabled={busy}
													onClick={() => runSetup(item)}
													size="sm"
													variant="outline"
												>
													Run setup check
												</Button>
											) : null}
										</div>
									}
									description={`${item.repositories.join(", ") || "No repositories"} · ${item.privacy === "private" ? "Private" : "Shared"} · ${item.published ? "Published" : "Draft"}`}
									key={item.id}
									title={item.name}
								/>
							))
						: matchingVault.map((item) => (
								<SettingsItem
									actions={
										<div className="flex max-w-64 flex-wrap items-center justify-end gap-2">
											<span
												aria-label={
													item.hasValue ? "Value hidden" : "Value not set"
												}
												className="text-muted-foreground"
											>
												{item.hasValue ? "••••••••" : "Not set"}
											</span>
											<Button
												disabled={busy}
												onClick={() => {
													setError(null);
													setEditingVault(item);
													setVaultOpen(true);
												}}
												size="sm"
												variant="ghost"
											>
												Edit
											</Button>
											<Button
												disabled={busy}
												onClick={() => setDeleting(item)}
												size="sm"
												variant="ghost"
											>
												Delete
											</Button>
										</div>
									}
									description={`${item.kind === "variable" ? "Environment variable" : "Network secret"} · ${item.environmentIds.length ? "Selected environments" : "All environments"}`}
									key={item.id}
									title={item.key}
								/>
							))}
				</SettingsGroup>
			) : null}

			{tabEntries?.length === 0 ? (
				<SettingsCard>
					<p className="py-3 text-muted-foreground text-sm">
						{tab === "environments"
							? "No cloud environments yet. Create one to save your repository setup."
							: "No vault entries yet. Add a variable or a network secret."}
					</p>
				</SettingsCard>
			) : null}
			{tabEntries && tabEntries.length > 0 && tabMatches.length === 0 ? (
				<SettingsCard>
					<p className="py-3 text-muted-foreground text-sm" role="status">
						{tab === "environments"
							? tl("No matching environments.")
							: tl("No matching vault entries.")}
					</p>
				</SettingsCard>
			) : null}
		</>
	);
}

export function DeleteVaultEntryDialog({
	busy,
	deleting,
	error,
	save,
	setDeleting,
	snapshot,
}: {
	busy: boolean;
	deleting: CloudVaultEntry | null;
	error: string | null;
	save: (next: CloudEnvironmentWrite) => Promise<boolean>;
	setDeleting: Dispatch<SetStateAction<CloudVaultEntry | null>>;
	snapshot: CloudEnvironmentsSnapshot | null;
}) {
	const tl = useLiteralMessages();
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!(open || busy)) {
					setDeleting(null);
				}
			}}
			open={deleting !== null}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete vault entry</DialogTitle>
					<DialogDescription>
						{tl(
							"Delete {key}? Environments that request this key will no longer receive its value.",
							{ key: deleting?.key ?? "" }
						)}
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button
						disabled={busy}
						onClick={() => setDeleting(null)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						disabled={busy}
						onClick={async () => {
							if (
								snapshot &&
								deleting &&
								(await save({
									...snapshot,
									vault: snapshot.vault.filter(
										(item) => item.id !== deleting.id
									),
								}))
							) {
								setDeleting(null);
							}
						}}
						variant="destructive"
					>
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function SharedTemplatesSection({
	busy,
	setBusy,
	setError,
	setShared,
	setSnapshot,
	shared,
	snapshot,
	target,
}: {
	busy: boolean;
	setBusy: (busy: boolean) => void;
	setError: (error: string | null) => void;
	setShared: (shared: CloudEnvironment[] | null) => void;
	setSnapshot: (snapshot: CloudEnvironmentsSnapshot | null) => void;
	shared: CloudEnvironment[] | null;
	snapshot: CloudEnvironmentsSnapshot;
	target: ApiTarget;
}) {
	return (
		<SettingsSection
			caption="Import a template as a private draft. Credentials are never included."
			headerAction={
				<Button
					disabled={busy}
					onClick={async () => {
						setError(null);
						try {
							setShared(await fetchSharedCloudEnvironments(target));
						} catch (failure) {
							setError(errorMessage(failure));
						}
					}}
					size="sm"
					variant="outline"
				>
					Browse shared templates
				</Button>
			}
			title="Shared environment templates"
		>
			{shared && shared.length > 0 ? (
				<SettingsGroup>
					{shared.map((environment) => (
						<SettingsItem
							actions={
								<Button
									disabled={busy}
									onClick={async () => {
										setBusy(true);
										setError(null);
										try {
											setSnapshot(
												await importSharedCloudEnvironment(
													target,
													environment.id,
													snapshot.revision
												)
											);
										} catch (failure) {
											setError(errorMessage(failure));
										} finally {
											setBusy(false);
										}
									}}
									size="sm"
									variant="outline"
								>
									Import template
								</Button>
							}
							key={environment.id}
							title={environment.name}
						/>
					))}
				</SettingsGroup>
			) : null}
			{shared?.length === 0 ? (
				<SettingsCard>
					<p className="py-3 text-muted-foreground text-sm">
						No shared templates available.
					</p>
				</SettingsCard>
			) : null}
		</SettingsSection>
	);
}

export function SetupResultDialog({
	result,
	setResult,
}: {
	result: string | null;
	setResult: (result: string | null) => void;
}) {
	return (
		<Dialog
			onOpenChange={(open) => {
				if (!open) {
					setResult(null);
				}
			}}
			open={result !== null}
		>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Cloud environment setup result</DialogTitle>
					<DialogDescription>
						Setup output is redacted by the node. This checks repository setup
						in a temporary container, then discards it. It does not start an
						agent task.
					</DialogDescription>
				</DialogHeader>
				<pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 font-mono text-xs">
					{result}
				</pre>
				<DialogFooter>
					<Button onClick={() => setResult(null)} variant="outline">
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
