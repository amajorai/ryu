import { Add01Icon, Link01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";

import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";

import { useCallback, useEffect, useState } from "react";
import { sileo } from "sileo";
import { openExternal } from "@/lib/tauri-bridge.ts";
import { useIdentities } from "@/src/hooks/useIdentities.ts";
import {
	ConnectionDetail,
	CreateConnectionForm,
} from "./IdentitiesPage.parts.tsx";

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
	const tl = useLiteralMessages();

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
		return <SkeletonRows rows={6} spacing="library" />;
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="scroll-fade flex-1 overflow-y-auto p-6">
				{error ? (
					<p className="mb-3 text-sm text-status-destructive">{error}</p>
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
									title: tl("Connection for {domain} created", {
										domain: conn.domain,
									}),
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
									aria-label="New connection"
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
									aria-label="New connection"
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
									return true;
								} catch (e) {
									sileo.error({
										title:
											e instanceof Error ? e.message : "Could not import state",
									});
									return false;
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
						<Button onClick={openCreate} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={Add01Icon} />
							New connection
						</Button>
					</Empty>
				)}
			</div>
		</div>
	);
}
