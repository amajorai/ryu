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
import type { ApiTarget } from "@ryuhq/core-client/client.ts";
import { useEffect, useId, useState } from "react";
import {
	type BackupDestination,
	generateBackupKey,
	type SaveBackupDestination,
	saveBackupDestination,
} from "@/src/lib/api/backups.ts";
import { message } from "./BackupSettings-shared.ts";

export function DestinationDialog({
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
