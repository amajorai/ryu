import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type { ApiTarget } from "@ryuhq/core-client/client.ts";
import { useQuery } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { z } from "zod";
import { useActiveNode } from "@/src/hooks/useActiveNode.ts";
import {
	type BackupDestination,
	type BackupRecord,
	type BackupScope,
	createBackup,
	getBackups,
	listBackups,
	saveBackupPolicy,
} from "@/src/lib/api/backups.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { spaceListQueryOptions } from "@/src/lib/space-list-query.ts";
import { BackupConfirmDialogs } from "./BackupSettings-confirm-dialogs.tsx";
import { DestinationDialog } from "./BackupSettings-destination-dialog.tsx";
import { BackupDestinationList } from "./BackupSettings-destination-list.tsx";
import { OperationRow } from "./BackupSettings-operation-row.tsx";
import { BackupRecordsList } from "./BackupSettings-records-list.tsx";
import { BackupScopeFields } from "./BackupSettings-scope-fields.tsx";
import { active, EMPTY, message } from "./BackupSettings-shared.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

export function BackupSettings(props: { target: ApiTarget; spaceId?: string }) {
	const key = JSON.stringify([
		props.target.url,
		props.target.token ?? null,
		props.target.userJwt ?? null,
		props.spaceId ?? null,
	]);
	return <ScopedBackupSettings key={key} {...props} />;
}

function ScopedBackupSettings({
	target,
	spaceId,
}: {
	target: ApiTarget;
	spaceId?: string;
}) {
	const tl = useLiteralMessages();
	const [actionError, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [trackedOperation, setTrackedOperation] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [dialog, setDialog] = useState(false);
	const [editing, setEditing] = useState<BackupDestination>();
	const [destinationId, setDestinationId] = useState("");
	const [selection, setSelection] = useState(spaceId ?? "node");
	const spacesQuery = useQuery(spaceListQueryOptions(target), queryClient);
	const spaces = spacesQuery.data ?? [];
	const [schedule, setSchedule] = useState("0 2 * * *");
	const [retention, setRetention] = useState(7);
	const [records, setRecords] = useState<BackupRecord[] | null>(null);
	const [restore, setRestore] = useState<BackupRecord | null>(null);
	const [remove, setRemove] = useState<BackupDestination | null>(null);
	const id = useId();
	const targetRef = useRef(target);
	targetRef.current = target;
	const mounted = useRef(true);
	const browseController = useRef<AbortController | null>(null);
	const queryTarget = useMemo(
		() => ({ ...target }),
		[target.url, target.token, target.userJwt, target.fetch]
	);
	const queryKey = useMemo(
		() => [
			"backup-overview",
			queryTarget.url,
			queryTarget.token ?? null,
			queryTarget.userJwt ?? null,
		],
		[queryTarget]
	);
	const backupQuery = useQuery(
		{
			queryKey,
			queryFn: ({ signal }) => getBackups(queryTarget, signal),
			staleTime: 0,
			retry: false,
			refetchInterval: (query) =>
				query.state.data?.operations.some(active)
					? 1500
					: query.state.data?.policies.some((policy) => policy.enabled)
						? 15_000
						: false,
		},
		queryClient
	);
	const overview = backupQuery.data ?? EMPTY;
	const running = overview.operations.some(active);
	const loading = backupQuery.isPending;
	const error =
		actionError ?? (backupQuery.error ? message(backupQuery.error) : null);
	const scope: BackupScope =
		selection === "node"
			? { kind: "node" }
			: { kind: "space", spaceId: selection };
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (backupQuery.data) {
			setDestinationId((current) =>
				backupQuery.data.destinations.some(
					(destination) => destination.id === current
				)
					? current
					: (backupQuery.data.destinations[0]?.id ?? "")
			);
		}
	}, [backupQuery.data]);
	const reload = useCallback(async () => {
		if (!mounted.current) {
			return;
		}
		setError(null);
		await queryClient.cancelQueries({ queryKey, exact: true });
		if (!mounted.current) {
			return;
		}
		try {
			await queryClient.fetchQuery({
				queryKey,
				queryFn: ({ signal }) => getBackups(queryTarget, signal),
				staleTime: 0,
				retry: false,
			});
		} catch (error) {
			if (mounted.current) {
				throw error;
			}
		}
	}, [queryKey, queryTarget]);
	useEffect(() => {
		const operation = overview.operations.find(
			(entry) => entry.id === trackedOperation
		);
		if (!operation || active(operation)) {
			return;
		}
		setNotice(
			operation.status === "completed"
				? `${operation.action === "restore" ? "Restore" : "Backup"} completed.`
				: null
		);
		setTrackedOperation(null);
	}, [overview.operations, trackedOperation]);
	useEffect(() => {
		setRecords(null);
		if (browseController.current) {
			browseController.current.abort();
			browseController.current = null;
			setBusy(false);
		}
		return () => {
			browseController.current?.abort();
		};
	}, [destinationId, selection]);
	const policy = overview.policies.find(
		(p) =>
			p.destinationId === destinationId &&
			JSON.stringify(p.scope) === JSON.stringify(scope)
	);
	useEffect(() => {
		setSchedule(policy?.schedule ?? "0 2 * * *");
		setRetention(policy?.retentionCount ?? 7);
	}, [policy?.schedule, policy?.retentionCount]);
	async function act<TResult>(action: () => Promise<TResult>, success: string) {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const result = await action();
			const operation = z
				.object({ status: z.string(), id: z.string() })
				.safeParse(result);
			if (operation.success) {
				setTrackedOperation(operation.data.id);
			}
			setNotice(success);
			await reload();
		} catch (error) {
			setError(message(error));
		} finally {
			setBusy(false);
		}
	}
	async function browse() {
		browseController.current?.abort();
		const controller = new AbortController();
		browseController.current = controller;
		setBusy(true);
		setError(null);
		try {
			const records = await listBackups(
				targetRef.current,
				destinationId,
				selection === "node" ? undefined : selection,
				controller.signal
			);
			if (!controller.signal.aborted && mounted.current) {
				setRecords(records);
			}
		} catch (error) {
			if (!controller.signal.aborted && mounted.current) {
				setError(message(error));
			}
		} finally {
			if (
				browseController.current === controller &&
				!controller.signal.aborted &&
				mounted.current
			) {
				browseController.current = null;
				setBusy(false);
			}
		}
	}
	const shownOperations = overview.operations
		.filter(
			(operation) =>
				!spaceId ||
				(operation.scope.kind === "space" &&
					operation.scope.spaceId === spaceId)
		)
		.slice(0, 8);
	return (
		<SettingsSection
			caption="Encrypted backups to your S3-compatible storage. Available to node administrators."
			title="S3 backups"
		>
			<div className="grid gap-5">
				{loading ? (
					<p className="text-muted-foreground text-sm" role="status">
						Loading backup settings…
					</p>
				) : null}
				{error && (
					<div className="grid gap-2">
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
						<Button
							onClick={() => {
								reload().catch((error) => setError(message(error)));
							}}
							size="sm"
							variant="outline"
						>
							Retry
						</Button>
					</div>
				)}
				{notice && (
					<p className="text-muted-foreground text-sm" role="status">
						{notice}
					</p>
				)}
				{!loading && (
					<>
						<div className="flex flex-wrap items-center justify-between gap-3">
							<h3 className="font-medium text-sm">Storage destinations</h3>
							<Button
								onClick={() => {
									setEditing(undefined);
									setDialog(true);
								}}
								size="sm"
								variant="outline"
							>
								Add destination
							</Button>
						</div>
						<BackupDestinationList
							act={act}
							busy={busy}
							overview={overview}
							setDialog={setDialog}
							setEditing={setEditing}
							setRemove={setRemove}
							targetRef={targetRef}
						/>
						{overview.destinations.length > 0 && (
							<SettingsCard className="grid gap-4">
								<h3 className="font-medium text-sm">
									Backup scope &amp; schedule
								</h3>
								<BackupScopeFields
									busy={busy}
									destinationId={destinationId}
									id={id}
									overview={overview}
									selection={selection}
									setDestinationId={setDestinationId}
									setSelection={setSelection}
									spaceId={spaceId}
									spaces={spaces}
								/>
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="grid gap-2">
										<Label htmlFor={`${id}-cron`}>Schedule (UTC)</Label>
										<Input
											disabled={busy}
											id={`${id}-cron`}
											onChange={(event) => setSchedule(event.target.value)}
											value={schedule}
										/>
										<p className="text-muted-foreground text-xs">
											Five-field cron. Default: every day at 02:00 UTC.
										</p>
									</div>
									<div className="grid gap-2">
										<Label htmlFor={`${id}-retention`}>Backups to keep</Label>
										<Input
											disabled={busy}
											id={`${id}-retention`}
											max={500}
											min={1}
											onChange={(event) =>
												setRetention(Number(event.target.value))
											}
											type="number"
											value={retention}
										/>
										<p className="text-muted-foreground text-xs">
											Older backups are removed after a successful backup.
										</p>
									</div>
								</div>
								<div className="flex flex-wrap gap-2">
									<Button
										disabled={busy || running || !destinationId}
										onClick={() => {
											act(
												() =>
													createBackup(targetRef.current, {
														destinationId,
														scope,
														idempotencyKey: crypto.randomUUID(),
													}),
												"Backup queued. Progress appears below."
											).catch(() => undefined);
										}}
										size="sm"
									>
										Back up now
									</Button>
									<Button
										disabled={busy || !destinationId}
										onClick={() => {
											act(
												() =>
													saveBackupPolicy(targetRef.current, {
														destinationId,
														scope,
														schedule,
														retentionCount: retention,
														enabled: true,
													}),
												"Backup schedule saved."
											).catch(() => undefined);
										}}
										size="sm"
										variant="outline"
									>
										{policy ? "Save schedule" : "Enable schedule"}
									</Button>
									{policy && (
										<Button
											disabled={busy}
											onClick={() => {
												act(
													() =>
														saveBackupPolicy(targetRef.current, {
															destinationId,
															scope,
															schedule,
															retentionCount: retention,
															enabled: !policy.enabled,
														}),
													policy.enabled
														? "Schedule paused."
														: "Schedule enabled."
												).catch(() => undefined);
											}}
											size="sm"
											variant="ghost"
										>
											{policy.enabled ? "Pause schedule" : "Resume schedule"}
										</Button>
									)}
									<Button
										disabled={busy || !destinationId}
										onClick={() => {
											browse().catch(() => undefined);
										}}
										size="sm"
										variant="ghost"
									>
										Browse backups
									</Button>
								</div>
								{policy && (
									<p className="text-muted-foreground text-xs">
										{tl(
											"Schedule {state, select, enabled {enabled} other {paused}} · {schedule} UTC · keeps {retentionCount}",
											{
												state: policy.enabled ? "enabled" : "paused",
												schedule: policy.schedule,
												retentionCount: String(policy.retentionCount),
											}
										)}
									</p>
								)}
							</SettingsCard>
						)}
						{records && (
							<BackupRecordsList
								busy={busy}
								records={records}
								running={running}
								setRestore={setRestore}
							/>
						)}
						{shownOperations.length > 0 && (
							<div className="grid gap-3">
								<h3 className="font-medium text-sm">Recent activity</h3>
								{shownOperations.map((operation) => (
									<OperationRow key={operation.id} operation={operation} />
								))}
							</div>
						)}
					</>
				)}
			</div>
			<DestinationDialog
				destination={editing}
				onClose={() => setDialog(false)}
				onSaved={reload}
				open={dialog}
				target={target}
			/>
			<BackupConfirmDialogs
				act={act}
				busy={busy}
				destinationId={destinationId}
				overview={overview}
				remove={remove}
				restore={restore}
				setRemove={setRemove}
				setRestore={setRestore}
				targetRef={targetRef}
			/>
		</SettingsSection>
	);
}

export function NodeBackupSettings() {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	return <BackupSettings key={node.url} target={target} />;
}
