// Import (.env / JSON paste or file) and export (format picker, copy, download)
// for the selected environment and folder. Pasted and exported plaintext lives
// only in this dialog's state and is dropped when the dialog closes.

import { Copy01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
import { Label } from "@ryu/ui/components/label.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ryu/ui/components/select.tsx";
import { Switch } from "@ryu/ui/components/switch.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import { sileo } from "sileo";
import { useStepUp } from "@/src/components/StepUpDialog.tsx";
import { sharedValuesMissingMessage } from "@/src/lib/access-refusal.ts";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	exportVaultSecrets,
	importVaultSecrets,
	type VaultExportFormat,
	type VaultScope,
} from "@/src/lib/api/vault.ts";
import { readWithStepUp, vaultErrorMessage } from "./vault-errors.ts";
import {
	exportFileName,
	guessImportFormat,
	ROOT_FOLDER,
} from "./vault-view.ts";

export type VaultTransferMode = "import" | "export";

const EXPORT_FORMATS: { label: string; value: VaultExportFormat }[] = [
	{ value: "dotenv", label: ".env" },
	{ value: "json", label: "JSON" },
	{ value: "yaml", label: "YAML" },
	{ value: "shell", label: "Shell exports" },
	{ value: "k8s-secret", label: "Kubernetes Secret" },
];

const IMPORT_FORMATS: { label: string; value: "dotenv" | "json" }[] = [
	{ value: "dotenv", label: ".env" },
	{ value: "json", label: "JSON" },
];

/** Import targets that need no extra id; team imports go through the CLI. */
const IMPORT_SCOPE_LABELS = new Map<VaultScope, string>([
	["user", "User"],
	["node", "Node"],
	["org", "Organization"],
]);

interface VaultTransferDialogProps {
	environment: string;
	folder: string;
	importScopes: VaultScope[];
	mode: VaultTransferMode | null;
	onOpenChange: (open: boolean) => void;
	target: ApiTarget;
}

export function VaultTransferDialog({
	environment,
	folder,
	importScopes,
	mode,
	onOpenChange,
	target,
}: VaultTransferDialogProps) {
	const location =
		folder === ROOT_FOLDER ? environment : `${environment} · ${folder}`;
	return (
		<Dialog onOpenChange={onOpenChange} open={mode !== null}>
			<DialogContent className="sm:max-w-lg">
				{mode === "import" ? (
					<ImportBody
						environment={environment}
						folder={folder}
						location={location}
						onDone={() => onOpenChange(false)}
						scopes={importScopes}
						target={target}
					/>
				) : null}
				{mode === "export" ? (
					<ExportBody
						environment={environment}
						folder={folder}
						location={location}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function ImportBody({
	environment,
	folder,
	location,
	onDone,
	scopes,
	target,
}: {
	environment: string;
	folder: string;
	location: string;
	onDone: () => void;
	scopes: VaultScope[];
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	const scopeOptions = scopes.filter((scope) => IMPORT_SCOPE_LABELS.get(scope));
	const [scope, setScope] = useState<VaultScope>(scopeOptions[0] ?? "user");
	const [format, setFormat] = useState<"dotenv" | "json">("dotenv");
	const [content, setContent] = useState("");
	const [overwrite, setOverwrite] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) {
			return;
		}
		const text = await file.text();
		setFormat(guessImportFormat(file.name, text));
		setContent(text);
	};

	// Not a React Query mutation: its cache would keep the pasted values.
	const submit = async () => {
		setError(null);
		setPending(true);
		try {
			const report = await importVaultSecrets(target, {
				scope,
				environment,
				path: folder,
				format,
				content,
				onConflict: overwrite ? "overwrite" : "skip",
			});
			setContent("");
			await queryClient.invalidateQueries({ queryKey: ["vault"] });
			sileo.success({
				title: "Import finished",
				description: tl(
					"{created} added, {updated} updated, {skipped} skipped",
					{
						created: report.created,
						skipped: report.skipped,
						updated: report.updated,
					}
				),
			});
			onDone();
		} catch (caught) {
			setError(vaultErrorMessage(caught, "Could not import."));
		} finally {
			setPending(false);
		}
	};

	return (
		<>
			<DialogHeader>
				<DialogTitle>Import secrets</DialogTitle>
				<DialogDescription>
					{tl("Into {location}.", { location })}
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-1.5">
					<Label htmlFor="vault-import-format">Format</Label>
					<Select
						items={IMPORT_FORMATS}
						onValueChange={(value: string) =>
							setFormat(value === "json" ? "json" : "dotenv")
						}
						value={format}
					>
						<SelectTrigger id="vault-import-format">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{IMPORT_FORMATS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="vault-import-scope">Scope</Label>
					<Select
						items={scopeOptions.map((item) => ({
							value: item,
							label: IMPORT_SCOPE_LABELS.get(item) ?? item,
						}))}
						onValueChange={(value: string) => {
							if (value === "user" || value === "node" || value === "org") {
								setScope(value);
							}
						}}
						value={scope}
					>
						<SelectTrigger id="vault-import-scope">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{scopeOptions.map((item) => (
								<SelectItem key={item} value={item}>
									{IMPORT_SCOPE_LABELS.get(item)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="vault-import-content">Contents</Label>
				<Textarea
					autoComplete="off"
					className="min-h-40"
					id="vault-import-content"
					onChange={(event) => setContent(event.target.value)}
					placeholder={format === "json" ? '{ "API_KEY": "…" }' : "API_KEY=…"}
					spellCheck={false}
					value={content}
					variant="code-caption"
				/>
				<div className="flex items-center justify-between gap-3">
					<Label htmlFor="vault-import-file" size="compact" tone="muted">
						Or choose a file
					</Label>
					<input
						accept=".env,.json,.txt,text/plain,application/json"
						className="max-w-56 text-xs file:mr-2 file:rounded-full file:border-0 file:bg-muted file:px-3 file:py-1 file:text-xs"
						id="vault-import-file"
						onChange={readFile}
						type="file"
					/>
				</div>
			</div>
			<div className="flex items-center justify-between gap-3">
				<Label htmlFor="vault-import-overwrite">
					Overwrite existing values
				</Label>
				<Switch
					checked={overwrite}
					id="vault-import-overwrite"
					onCheckedChange={(checked: boolean) => setOverwrite(checked)}
				/>
			</div>
			{error ? (
				<p className="text-sm text-status-destructive">{error}</p>
			) : null}
			<DialogFooter>
				<Button
					disabled={pending || content.trim() === ""}
					loading={pending}
					onClick={submit}
					variant="mono"
				>
					Import
				</Button>
			</DialogFooter>
		</>
	);
}

function ExportBody({
	environment,
	folder,
	location,
	target,
}: {
	environment: string;
	folder: string;
	location: string;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const stepUp = useStepUp();
	const [format, setFormat] = useState<VaultExportFormat>("dotenv");
	const [content, setContent] = useState<string | null>(null);
	const [count, setCount] = useState(0);
	const [sharedError, setSharedError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Not a React Query mutation: its cache would keep the exported values.
	const run = async () => {
		setError(null);
		setPending(true);
		try {
			// Shared values ask for a confirmation when no organization or team
			// node vouches for the export. A dismissed prompt exports nothing.
			const result = await readWithStepUp(stepUp.guard, () =>
				exportVaultSecrets(target, {
					environment,
					path: folder,
					format,
				})
			);
			if (result !== null) {
				setContent(result.content);
				setCount(result.count);
				setSharedError(result.sharedError || null);
			}
		} catch (caught) {
			setError(vaultErrorMessage(caught, "Could not export."));
		} finally {
			setPending(false);
		}
	};

	const copy = async () => {
		if (content === null) {
			return;
		}
		try {
			await navigator.clipboard.writeText(content);
			sileo.success({ title: "Copied" });
		} catch {
			sileo.error({ title: "Could not copy" });
		}
	};

	const download = () => {
		if (content === null) {
			return;
		}
		const url = URL.createObjectURL(
			new Blob([content], { type: "text/plain" })
		);
		const link = window.document.createElement("a");
		link.href = url;
		link.download = exportFileName(format, environment);
		window.document.body.append(link);
		link.click();
		link.remove();
		URL.revokeObjectURL(url);
	};

	return (
		<>
			{stepUp.dialog}
			<DialogHeader>
				<DialogTitle>Export secrets</DialogTitle>
				<DialogDescription>
					{tl("Values you can read from {location}. Exports are audited.", {
						location,
					})}
				</DialogDescription>
			</DialogHeader>
			<div className="flex items-end gap-3">
				<div className="flex-1 space-y-1.5">
					<Label htmlFor="vault-export-format">Format</Label>
					<Select
						items={EXPORT_FORMATS}
						onValueChange={(value: string) => {
							const next = EXPORT_FORMATS.find((item) => item.value === value);
							if (next) {
								setFormat(next.value);
								setContent(null);
							}
						}}
						value={format}
					>
						<SelectTrigger id="vault-export-format">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{EXPORT_FORMATS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<Button
					disabled={pending}
					loading={pending}
					onClick={run}
					variant="mono"
				>
					Export
				</Button>
			</div>
			{content === null ? null : (
				<div className="space-y-1.5">
					<Label htmlFor="vault-export-content">
						{count} {count === 1 ? "value" : "values"}
					</Label>
					{sharedError ? (
						<p className="text-status-destructive text-xs">
							{sharedValuesMissingMessage(sharedError)}
						</p>
					) : null}
					<Textarea
						className="min-h-40"
						id="vault-export-content"
						readOnly
						spellCheck={false}
						value={content}
						variant="code-caption"
					/>
					<div className="flex justify-end gap-2">
						<Button onClick={copy} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={Copy01Icon} />
							Copy
						</Button>
						<Button onClick={download} size="sm" variant="outline">
							<HugeiconsIcon className="size-4" icon={Download01Icon} />
							Download
						</Button>
					</div>
				</div>
			)}
			{error ? (
				<p className="text-sm text-status-destructive">{error}</p>
			) : null}
		</>
	);
}
