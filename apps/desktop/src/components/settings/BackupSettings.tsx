import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { ApiError, type ApiTarget } from "@ryuhq/core-client/client.ts";
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
	type BackupOperation,
	type BackupOverview,
	type BackupRecord,
	type BackupScope,
	createBackup,
	deleteBackupDestination,
	deleteBackupPolicy,
	generateBackupKey,
	getBackups,
	listBackups,
	restoreBackup,
	type SaveBackupDestination,
	saveBackupDestination,
	saveBackupPolicy,
	testBackupDestination,
} from "@/src/lib/api/backups.ts";
import { toTarget } from "@/src/lib/api/client.ts";
import { queryClient } from "@/src/lib/query-client.ts";
import { spaceListQueryOptions } from "@/src/lib/space-list-query.ts";
import { formatDateTime } from "@/src/lib/timezone.ts";
import { SettingsCard, SettingsSection } from "./shared/settings-items.tsx";

const EMPTY: BackupOverview = {
	destinations: [],
	operations: [],
	policies: [],
};

function message<TError>(error: TError): string {
	if (error instanceof ApiError && error.serverMessage) {
		return error.serverMessage;
	}
	return error instanceof Error
		? error.message
		: "Backup request failed. Try again.";
}
function bytes(value: number): string {
	return value < 1024 * 1024
		? `${(value / 1024).toFixed(1)} KB`
		: `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
function active(operation: BackupOperation): boolean {
	return operation.status === "pending" || operation.status === "running";
}
function scopeLabel(scope: BackupScope): string {
	return scope.kind === "node"
		? "Entire node"
		: scope.kind === "space"
			? "Space"
			: `App · ${scope.namespace}`;
}

function DestinationDialog({
	target,
	open,
	destination,
	onClose,
	onSaved,
}: {
	target: ApiTarget;
	open: boolean;
	destination?: BackupDestination;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const id = useId();
	const [form, setForm] = useState<SaveBackupDestination>({
		name: "",
		endpoint: "",
		bucket: "",
		region: "us-east-1",
		prefix: "ryu",
		accessKeyId: "",
		secretAccessKey: "",
		recoveryKey: "",
		pathStyle: true,
		allowHttp: false,
		allowedApps: [],
	});
	const [savedKey, setSavedKey] = useState(false);
	const [appsInput, setAppsInput] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!open) {
			return;
		}
		setForm({
			name: destination?.name ?? "",
			endpoint: destination?.endpoint ?? "",
			bucket: destination?.bucket ?? "",
			region: destination?.region ?? "us-east-1",
			prefix: destination?.prefix ?? "ryu",
			accessKeyId: "",
			secretAccessKey: "",
			recoveryKey: "",
			pathStyle: destination?.pathStyle ?? true,
			allowHttp: destination?.allowHttp ?? false,
			allowedApps: destination?.allowedApps ?? [],
		});
		setSavedKey(false);
		setAppsInput(destination?.allowedApps.join(", ") ?? "");
		setError(null);
	}, [open, destination]);
	function field(
		key: keyof SaveBackupDestination,
		label: string,
		placeholder: string,
		secret = false
	) {
		const value = form[key];
		return (
			<div className="grid gap-2" key={key}>
				<Label htmlFor={`${id}-${key}`}>{label}</Label>
				<Input
					autoComplete={secret ? "new-password" : "off"}
					disabled={
						busy ||
						(Boolean(destination) &&
							["endpoint", "bucket", "prefix"].includes(key))
					}
					id={`${id}-${key}`}
					onChange={(event) =>
						setForm((current) => ({ ...current, [key]: event.target.value }))
					}
					placeholder={placeholder}
					required={key !== "prefix" && key !== "sessionToken"}
					type={secret ? "password" : "text"}
					value={isNativeText(value) ? value : ""}
				/>
			</div>
		);
	}
	async function generate() {
		setBusy(true);
		setError(null);
		try {
			const key = await generateBackupKey(target);
			setForm((current) => ({ ...current, recoveryKey: key.recoveryKey }));
			setSavedKey(false);
		} catch (error) {
			setError(message(error));
		} finally {
			setBusy(false);
		}
	}
	function downloadKey() {
		const url = URL.createObjectURL(
			new Blob([form.recoveryKey], { type: "text/plain" })
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = "ryu-backup-recovery-key.txt";
		link.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}
	return (
		<Dialog
			onOpenChange={(value) => {
				if (!(value || busy)) {
					onClose();
				}
			}}
			open={open}
		>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>
						{destination ? "Edit S3 destination" : "Add S3 destination"}
					</DialogTitle>
					<DialogDescription>
						Use an existing AWS S3, Cloudflare R2, or S3-compatible bucket. Ryu
						encrypts backups before uploading.
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-5"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setError(null);
						saveBackupDestination(
							target,
							{
								...form,
								allowedApps: appsInput
									.split(",")
									.map((value) => value.trim())
									.filter(Boolean),
							},
							destination?.id
						)
							.then(onSaved)
							.then(onClose)
							.catch((error) => setError(message(error)))
							.finally(() => setBusy(false));
					}}
				>
					{!destination && (
						<div className="grid gap-2">
							<Label htmlFor={`${id}-provider`}>Provider</Label>
							<NativeSelect
								defaultValue="custom"
								disabled={busy}
								id={`${id}-provider`}
								onChange={(event) => {
									if (event.target.value === "r2") {
										setForm((current) => ({
											...current,
											region: "auto",
											endpoint: "https://ACCOUNT_ID.r2.cloudflarestorage.com",
											pathStyle: true,
										}));
									}
									if (event.target.value === "aws") {
										setForm((current) => ({
											...current,
											region: "us-east-1",
											endpoint: "https://s3.us-east-1.amazonaws.com",
											pathStyle: true,
										}));
									}
								}}
							>
								<NativeSelectOption value="custom">
									S3-compatible storage
								</NativeSelectOption>
								<NativeSelectOption value="aws">Amazon S3</NativeSelectOption>
								<NativeSelectOption value="r2">
									Cloudflare R2
								</NativeSelectOption>
							</NativeSelect>
						</div>
					)}
					{field("name", "Destination name", "Production backups")}
					{field(
						"endpoint",
						"S3 endpoint",
						"https://s3.us-east-1.amazonaws.com"
					)}
					<div className="grid gap-4 sm:grid-cols-2">
						{field("bucket", "Bucket", "ryu-backups")}
						{field("region", "Region", "auto for R2")}
					</div>
					{field("prefix", "Object prefix", "ryu/production")}
					<div className="grid gap-4 sm:grid-cols-2">
						{field("accessKeyId", "Access key ID", "Access key ID", true)}
						{field(
							"secretAccessKey",
							"Secret access key",
							"Secret access key",
							true
						)}
					</div>
					{field(
						"sessionToken",
						"Session token (optional)",
						"For temporary AWS credentials",
						true
					)}
					<div className="grid gap-2">
						{field(
							"recoveryKey",
							"Recovery key",
							destination
								? "Enter the existing recovery key"
								: "Generate a key or enter an existing one",
							true
						)}
						<div className="flex flex-wrap gap-2">
							{!destination && (
								<Button
									disabled={busy}
									onClick={() => {
										generate().catch(() => undefined);
									}}
									size="sm"
									type="button"
									variant="outline"
								>
									Generate key
								</Button>
							)}
							<Button
								disabled={!form.recoveryKey || busy}
								onClick={downloadKey}
								size="sm"
								type="button"
								variant="outline"
							>
								Download recovery key
							</Button>
						</div>
						<p className="text-muted-foreground text-xs">
							Keep this key outside your node. A replacement node needs the same
							key, bucket, and prefix to recover your backups.
						</p>
					</div>
					<label className="flex items-center gap-3 text-sm">
						<Checkbox
							checked={savedKey}
							disabled={busy}
							onCheckedChange={(value) => setSavedKey(value === true)}
						/>
						I have saved my recovery key
					</label>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-apps`}>
							Apps allowed to use this destination
						</Label>
						<Input
							disabled={busy}
							id={`${id}-apps`}
							onChange={(event) => setAppsInput(event.target.value)}
							placeholder="@ryu/canvas, com.example.myapp"
							value={appsInput}
						/>
						<p className="text-muted-foreground text-xs">
							Optional app IDs, separated by commas. Each app also needs the
							backup permission and can access only its own snapshots.
						</p>
					</div>
					<label className="flex items-center gap-3 text-sm">
						<Checkbox
							checked={form.pathStyle}
							disabled={busy}
							onCheckedChange={(value) =>
								setForm((current) => ({
									...current,
									pathStyle: value === true,
								}))
							}
						/>
						Use path-style requests
					</label>
					<label className="flex items-center gap-3 text-sm">
						<Checkbox
							checked={form.allowHttp}
							disabled={busy}
							onCheckedChange={(value) =>
								setForm((current) => ({
									...current,
									allowHttp: value === true,
								}))
							}
						/>
						Allow HTTP for a trusted private S3 server
					</label>
					{error && (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button
							disabled={busy}
							onClick={onClose}
							type="button"
							variant="ghost"
						>
							Cancel
						</Button>
						<Button disabled={busy || !savedKey} loading={busy} type="submit">
							Validate &amp; save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

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
						{overview.destinations.length === 0 ? (
							<SettingsCard>
								<p className="text-sm">No S3 destinations yet</p>
								<p className="mt-1 text-muted-foreground text-sm">
									Connect a bucket to back up this node, individual Spaces, and
									approved apps.
								</p>
							</SettingsCard>
						) : (
							overview.destinations.map((destination) => (
								<SettingsCard key={destination.id}>
									<div className="flex flex-wrap items-center justify-between gap-3">
										<div className="min-w-0">
											<p className="font-medium text-sm">{destination.name}</p>
											<p className="mt-1 break-all text-muted-foreground text-xs">
												{destination.bucket}
												{destination.prefix ? ` / ${destination.prefix}` : ""} ·{" "}
												{destination.region}
											</p>
											<p className="mt-1 text-muted-foreground text-xs">
												{destination.allowedApps.length
													? `${destination.allowedApps.length} approved ${destination.allowedApps.length === 1 ? "app" : "apps"}`
													: "No app access"}
											</p>
										</div>
										<div className="flex gap-1">
											<Button
												disabled={busy}
												onClick={() => {
													act(
														() =>
															testBackupDestination(
																targetRef.current,
																destination.id
															),
														"Connection verified: read, write, list and delete passed."
													).catch(() => undefined);
												}}
												size="sm"
												variant="ghost"
											>
												Test
											</Button>
											<Button
												disabled={busy}
												onClick={() => {
													setEditing(destination);
													setDialog(true);
												}}
												size="sm"
												variant="ghost"
											>
												Edit
											</Button>
											<Button
												disabled={busy}
												onClick={() => setRemove(destination)}
												size="sm"
												variant="ghost"
											>
												Remove
											</Button>
										</div>
									</div>
								</SettingsCard>
							))
						)}
						{overview.destinations.length > 0 && (
							<SettingsCard className="grid gap-4">
								<h3 className="font-medium text-sm">
									Backup scope &amp; schedule
								</h3>
								<div className="grid gap-4 sm:grid-cols-2">
									<div className="grid gap-2">
										<Label htmlFor={`${id}-destination`}>Destination</Label>
										<NativeSelect
											disabled={busy}
											id={`${id}-destination`}
											onChange={(event) => setDestinationId(event.target.value)}
											value={destinationId}
										>
											{overview.destinations.map((d) => (
												<NativeSelectOption key={d.id} value={d.id}>
													{d.name}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</div>
									<div className="grid gap-2">
										<Label htmlFor={`${id}-scope`}>Back up</Label>
										<NativeSelect
											disabled={Boolean(spaceId) || busy}
											id={`${id}-scope`}
											onChange={(event) => setSelection(event.target.value)}
											value={selection}
										>
											{!spaceId && (
												<NativeSelectOption value="node">
													Entire node
												</NativeSelectOption>
											)}
											{spaceId && !spaces.some((s) => s.id === spaceId) && (
												<NativeSelectOption value={spaceId}>
													This Space
												</NativeSelectOption>
											)}
											{spaces.map((space) => (
												<NativeSelectOption key={space.id} value={space.id}>
													{space.name}
												</NativeSelectOption>
											))}
										</NativeSelect>
									</div>
								</div>
								<p className="text-muted-foreground text-xs">
									{selection === "node"
										? "Includes durable node data and files. Databases are snapshotted consistently; downloaded runtimes, caches, and node access tokens are excluded."
										: "Includes pages, databases, whiteboards, app documents, and files. Restores create a new private Space."}
								</p>
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
										Schedule {policy.enabled ? "enabled" : "paused"} ·{" "}
										{policy.schedule} UTC · keeps {policy.retentionCount}
									</p>
								)}
							</SettingsCard>
						)}
						{records && (
							<div className="grid gap-3">
								<h3 className="font-medium text-sm">Backups in S3</h3>
								{records.length === 0 && (
									<p className="text-muted-foreground text-sm">
										No backups found for this selection.
									</p>
								)}
								{records.slice(0, 100).map((record) => (
									<SettingsCard key={record.id}>
										<div className="flex flex-wrap items-center justify-between gap-3">
											<div>
												<p className="text-sm">
													{scopeLabel(record.scope)} ·{" "}
													{formatDateTime(record.createdAt)}
												</p>
												<p className="mt-1 text-muted-foreground text-xs">
													{bytes(record.bytes)} · Encrypted
												</p>
											</div>
											<Button
												disabled={
													busy || running || record.scope.kind === "app"
												}
												onClick={() => setRestore(record)}
												size="sm"
												variant="outline"
											>
												Restore
											</Button>
										</div>
									</SettingsCard>
								))}
							</div>
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
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setRestore(null);
					}
				}}
				open={Boolean(restore)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{restore?.scope.kind === "node"
								? "Prepare node recovery"
								: "Restore Space"}
						</DialogTitle>
						<DialogDescription>
							{restore?.scope.kind === "node"
								? "Ryu will verify and extract this backup into a new recovery folder. Your running node stays intact. The completed operation shows how to start the recovered node."
								: "Ryu will restore the backup into a new private Space and rebuild its search index. Your original Space stays intact."}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setRestore(null)} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								if (!restore) {
									return;
								}
								const record = restore;
								setRestore(null);
								act(
									() =>
										restoreBackup(targetRef.current, {
											destinationId,
											backupId: record.id,
											idempotencyKey: crypto.randomUUID(),
										}),
									"Restore queued. Progress appears below."
								).catch(() => undefined);
							}}
						>
							Restore backup
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			<Dialog
				onOpenChange={(open) => {
					if (!open) {
						setRemove(null);
					}
				}}
				open={Boolean(remove)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Remove destination</DialogTitle>
						<DialogDescription>
							This removes the destination and its schedules from Ryu. Backups
							already in S3 stay in the bucket.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button onClick={() => setRemove(null)} variant="ghost">
							Cancel
						</Button>
						<Button
							disabled={busy}
							onClick={() => {
								if (!remove) {
									return;
								}
								const destination = remove;
								setRemove(null);
								act(async () => {
									for (const policy of overview.policies.filter(
										(p) => p.destinationId === destination.id
									)) {
										await deleteBackupPolicy(targetRef.current, policy.id);
									}
									await deleteBackupDestination(
										targetRef.current,
										destination.id
									);
								}, "Destination removed. S3 backups were kept.").catch(
									() => undefined
								);
							}}
							variant="destructive"
						>
							Remove destination
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SettingsSection>
	);
}

function OperationRow({ operation }: { operation: BackupOperation }) {
	const parsed = z
		.object({
			recoveryPath: z.string().optional().catch(undefined),
			spaceId: z.string().optional().catch(undefined),
			needsReindex: z.boolean().optional().catch(undefined),
		})
		.safeParse(operation.result);
	const result = parsed.success ? parsed.data : {};
	const recoveryPath = isNativeText(result.recoveryPath)
		? result.recoveryPath
		: null;
	return (
		<SettingsCard>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm">
					{operation.action === "restore" ? "Restore" : "Backup"} ·{" "}
					{scopeLabel(operation.scope)}
				</p>
				<span
					className={`text-xs ${operation.status === "failed" ? "text-status-destructive" : "text-muted-foreground"}`}
					role="status"
				>
					{operation.status === "completed"
						? "Completed"
						: operation.status === "running"
							? "Running…"
							: operation.status === "pending"
								? "Queued"
								: "Failed"}
				</span>
			</div>
			<p className="mt-1 text-muted-foreground text-xs">
				{formatDateTime(operation.createdAt)}
				{operation.backup ? ` · ${bytes(operation.backup.bytes)}` : ""}
			</p>
			{operation.error && (
				<p className="mt-2 text-sm text-status-destructive" role="alert">
					{operation.error}
				</p>
			)}
			{isNativeText(result.spaceId) && (
				<p className="mt-2 text-sm">
					A new private Space has been restored.
					{result.needsReindex === true
						? " Source recovery completed; run re-indexing when an embedding model is available."
						: " Search indexing completed."}
				</p>
			)}
			{recoveryPath && (
				<div className="mt-3 grid gap-2">
					<p className="text-sm">
						Node recovery is ready. Stop Core, then start it using the recovered
						data folder:
					</p>
					<pre className="overflow-x-auto rounded-md bg-muted p-3 font-code text-xs">{`env -u RYU_MASTER_KEY RYU_KEYCHAIN=off RYU_DIR='${recoveryPath.replaceAll("'", "'\\''")}' ryu-core`}</pre>
					<p className="text-muted-foreground text-xs">
						The recovered master key is stored privately in this folder.
						Existing node data is unchanged.
					</p>
				</div>
			)}
		</SettingsCard>
	);
}

export function NodeBackupSettings() {
	const node = useActiveNode();
	const target = useMemo(() => toTarget(node), [node]);
	return <BackupSettings key={node.url} target={target} />;
}
