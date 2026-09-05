import {
	Add01Icon,
	Delete02Icon,
	Key01Icon,
	Link01Icon,
	RefreshIcon,
	SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ryu/ui/components/alert-dialog";
import { Badge } from "@ryu/ui/components/badge";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { Input } from "@ryu/ui/components/input";
import { Label } from "@ryu/ui/components/label";
import { Spinner } from "@ryu/ui/components/spinner";
import { Textarea } from "@ryu/ui/components/textarea";
import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import type { Connection, ConnectionStatus } from "@/src/lib/api/identities.ts";

/** Status badge for a connection's durable authentication state. */
function StatusBadge({ status }: { status: ConnectionStatus }) {
	if (status === "AUTHENTICATED") {
		return (
			<Badge className="gap-1" variant="secondary">
				<HugeiconsIcon className="size-3" icon={SquareLock01Icon} />
				Authenticated
			</Badge>
		);
	}
	return (
		<Badge className="gap-1" variant="outline">
			<HugeiconsIcon className="size-3" icon={Key01Icon} />
			Needs auth
		</Badge>
	);
}

export default function IdentitiesPage({
	initialNew = false,
	initialProfileId = null,
}: {
	/** Open the create-connection form on mount (e.g. `/identities/new`). */
	initialNew?: boolean;
	/** Focus the first connection under this profile when the list loads. */
	initialProfileId?: string | null;
}) {
	const {
		profiles,
		loading,
		error,
		refetch,
		create,
		creating,
		remove,
		deleting,
		login,
		loggingIn,
		importState,
		importing,
		poll,
		polling,
	} = useIdentities();

	// Detail pane: create form or a selected connection. The Identities sidebar
	// section is the profile picker — this page no longer ships a left list.
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [showCreate, setShowCreate] = useState(initialNew);
	const [profileFocusApplied, setProfileFocusApplied] = useState(false);

	const focusedProfile =
		profiles.find((p) => p.profile_id === initialProfileId) ?? null;
	const focusedConnections = focusedProfile?.connections ?? [];
	const allConnections = profiles.flatMap((p) => p.connections);
	const selected = allConnections.find((c) => c.id === selectedId) ?? null;

	// Deep-link focus: once profiles load, select the first connection under the
	// requested profile (sidebar / Library card). Skipped when creating.
	useEffect(() => {
		if (profileFocusApplied || initialNew || !initialProfileId || loading) {
			return;
		}
		const profile = profiles.find((p) => p.profile_id === initialProfileId);
		const first = profile?.connections[0];
		if (first) {
			setSelectedId(first.id);
			setShowCreate(false);
		}
		setProfileFocusApplied(true);
	}, [initialNew, initialProfileId, loading, profileFocusApplied, profiles]);

	// Re-seed when the manage route switches profile or opens create.
	useEffect(() => {
		setShowCreate(initialNew);
		if (initialNew) {
			setSelectedId(null);
			setProfileFocusApplied(true);
			return;
		}
		setProfileFocusApplied(false);
	}, [initialNew, initialProfileId]);

	const openCreate = useCallback(() => {
		setSelectedId(null);
		setShowCreate(true);
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await remove(id);
				if (selectedId === id) {
					setSelectedId(null);
				}
			} catch (e) {
				sileo.error({
					title: e instanceof Error ? e.message : "Could not delete connection",
				});
			}
		},
		[remove, selectedId]
	);

	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade flex-1 overflow-y-auto p-6">
				{error ? (
					<p className="mb-3 text-destructive text-sm">{error}</p>
				) : null}
				{showCreate ? (
					<CreateConnectionForm
						creating={creating}
						existingProfileIds={profiles.map((p) => p.profile_id)}
						onCancel={() => setShowCreate(false)}
						onCreate={async (input) => {
							try {
								const conn = await create(input);
								setShowCreate(false);
								setSelectedId(conn.id);
								sileo.success({
									title: `Connection for ${conn.domain} created`,
								});
							} catch (e) {
								sileo.error({
									title:
										e instanceof Error
											? e.message
											: "Could not create connection",
								});
							}
						}}
					/>
				) : null}
				{!(showCreate || selected) && initialProfileId && focusedProfile ? (
					<div className="mx-auto max-w-xl space-y-4">
						<div className="flex items-center justify-between gap-3">
							<div>
								<h2 className="font-medium text-lg">
									{focusedProfile.profile_id}
								</h2>
								<p className="text-muted-foreground text-sm">
									No connections under this profile yet.
								</p>
							</div>
							<Button onClick={openCreate} size="sm" variant="ghost">
								<HugeiconsIcon className="size-4" icon={Add01Icon} />
								Add connection
							</Button>
						</div>
					</div>
				) : null}
				{!showCreate && selected ? (
					<div className="mx-auto max-w-xl space-y-4">
						{focusedConnections.length > 1 ? (
							<div className="flex flex-wrap gap-1">
								{focusedConnections.map((conn) => (
									<Button
										key={conn.id}
										onClick={() => setSelectedId(conn.id)}
										size="sm"
										variant={selectedId === conn.id ? "secondary" : "ghost"}
									>
										{conn.domain}
									</Button>
								))}
								<Button
									onClick={openCreate}
									size="sm"
									title="New connection"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
								</Button>
							</div>
						) : (
							<div className="flex justify-end gap-1">
								<Button
									onClick={() => refetch()}
									size="sm"
									title="Refresh"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={RefreshIcon} />
								</Button>
								<Button
									onClick={openCreate}
									size="sm"
									title="New connection"
									variant="ghost"
								>
									<HugeiconsIcon className="size-4" icon={Add01Icon} />
								</Button>
							</div>
						)}
						<ConnectionDetail
							connection={selected}
							deleting={deleting === selected.id}
							importing={importing}
							loggingIn={loggingIn === selected.id}
							onDelete={() => handleDelete(selected.id)}
							onImport={async (state) => {
								try {
									await importState(selected.id, state);
									sileo.success({ title: "Credentials imported" });
								} catch (e) {
									sileo.error({
										title:
											e instanceof Error ? e.message : "Could not import state",
									});
								}
							}}
							onLogin={async () => {
								try {
									const flow = await login(selected.id);
									if (flow.kind.kind === "hosted") {
										await openExternal(flow.kind.url);
										sileo.info({
											title:
												"Login page opened in your browser — finish signing in, then select Check status",
										});
									} else {
										sileo.info({
											title: "This domain uses manual import — paste below",
										});
									}
								} catch (e) {
									sileo.error({
										title:
											e instanceof Error ? e.message : "Could not start login",
									});
								}
							}}
							onRefresh={async () => {
								try {
									await poll(selected.id);
								} catch (e) {
									sileo.error({
										title:
											e instanceof Error ? e.message : "Could not check status",
									});
								}
							}}
							polling={polling === selected.id}
						/>
					</div>
				) : null}
				{showCreate ||
				selected ||
				(initialProfileId && focusedProfile) ? null : (
					<Empty>
						<EmptyHeader>
							<HugeiconsIcon
								className="size-8 text-muted-foreground"
								icon={Link01Icon}
							/>
							<EmptyTitle>
								{profiles.length === 0
									? "No identities yet"
									: "Select an identity"}
							</EmptyTitle>
							<EmptyDescription>
								{profiles.length === 0
									? "Connect an agent to the websites and services it acts on. Each connection logs in to one domain; group them under a profile and bind that profile to an agent."
									: "Pick an identity from the sidebar to manage its connections, or create a new one."}
							</EmptyDescription>
						</EmptyHeader>
						<Button onClick={openCreate}>
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New connection
						</Button>
					</Empty>
				)}
			</div>
		</div>
	);
}

/** The create form: profile id (grouping key) + domain. */
function CreateConnectionForm({
	creating,
	existingProfileIds,
	onCreate,
	onCancel,
}: {
	creating: boolean;
	existingProfileIds: string[];
	onCreate: (input: { profile_id: string; domain: string }) => Promise<void>;
	onCancel: () => void;
}) {
	const [profileId, setProfileId] = useState("");
	const [domain, setDomain] = useState("");

	const canSubmit = profileId.trim() !== "" && domain.trim() !== "";

	return (
		<div className="mx-auto max-w-xl space-y-4">
			<h2 className="font-medium text-lg">New connection</h2>
			<p className="text-muted-foreground text-sm">
				A profile groups every domain an agent should be logged in to. Reuse an
				existing profile name or create a new one.
			</p>
			<div className="space-y-1.5">
				<Label htmlFor="conn-profile">Profile</Label>
				<Input
					id="conn-profile"
					list="identity-profile-ids"
					onChange={(e) => setProfileId(e.target.value)}
					placeholder="personal"
					value={profileId}
				/>
				<datalist id="identity-profile-ids">
					{existingProfileIds.map((id) => (
						<option key={id} value={id} />
					))}
				</datalist>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="conn-domain">Domain</Label>
				<Input
					id="conn-domain"
					onChange={(e) => setDomain(e.target.value)}
					placeholder="app.example.com"
					value={domain}
				/>
			</div>
			<div className="flex gap-2">
				<Button
					disabled={!canSubmit}
					loading={creating}
					onClick={() => {
						onCreate({
							profile_id: profileId.trim(),
							domain: domain.trim(),
						});
					}}
				>
					Create
				</Button>
				<Button onClick={onCancel} variant="ghost">
					Cancel
				</Button>
			</div>
		</div>
	);
}

/** The detail pane for one connection: status, start-login, manual import, delete. */
function ConnectionDetail({
	connection,
	deleting,
	importing,
	loggingIn,
	onDelete,
	onImport,
	onLogin,
	onRefresh,
	polling,
}: {
	connection: Connection;
	deleting: boolean;
	importing: boolean;
	loggingIn: boolean;
	onDelete: () => void;
	onImport: (state: string) => Promise<void>;
	onLogin: () => Promise<void>;
	onRefresh: () => void;
	polling: boolean;
}) {
	const [manualState, setManualState] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);

	return (
		<div className="mx-auto max-w-xl space-y-5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 space-y-1">
					<h2 className="truncate font-medium text-lg">{connection.domain}</h2>
					<p className="text-muted-foreground text-sm">
						Profile{" "}
						<span className="font-medium text-foreground">
							{connection.profile_id}
						</span>
					</p>
				</div>
				<StatusBadge status={connection.status} />
			</div>

			<div className="flex flex-wrap gap-2">
				<Button loading={loggingIn} onClick={onLogin}>
					Start login
				</Button>
				<Button loading={polling} onClick={onRefresh} variant="ghost">
					{!polling && <HugeiconsIcon className="size-4" icon={RefreshIcon} />}
					Check status
				</Button>
				<Button
					loading={deleting}
					onClick={() => setConfirmDelete(true)}
					variant="destructive"
				>
					{!deleting && (
						<HugeiconsIcon className="size-4" icon={Delete02Icon} />
					)}
					Delete
				</Button>
				<AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete this connection?</AlertDialogTitle>
							<AlertDialogDescription>
								This permanently deletes the connection to{" "}
								<span className="font-medium text-foreground">
									{connection.domain}
								</span>{" "}
								and its saved sign-in. This cannot be undone.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								disabled={deleting}
								onClick={(e) => {
									// Keep the dialog open while the request runs.
									e.preventDefault();
									onDelete();
									setConfirmDelete(false);
								}}
								variant="destructive"
							>
								{deleting ? "Deleting…" : "Delete"}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</div>

			<div className="space-y-2 rounded-lg bg-card p-4">
				<Label htmlFor="manual-state">Manual import</Label>
				<p className="text-muted-foreground text-xs">
					Paste a cookie, token, or session blob to authenticate this connection
					directly. It is sealed before it touches disk and is never returned or
					shown to the model.
				</p>
				<Textarea
					className="min-h-28 font-mono text-xs"
					id="manual-state"
					onChange={(e) => setManualState(e.target.value)}
					placeholder="session=…; token=…"
					value={manualState}
				/>
				<Button
					disabled={manualState.trim() === ""}
					loading={importing}
					onClick={async () => {
						await onImport(manualState.trim());
						setManualState("");
					}}
					size="sm"
				>
					Import credentials
				</Button>
			</div>
		</div>
	);
}
