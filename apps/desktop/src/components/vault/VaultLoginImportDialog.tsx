// Import saved logins from a password export (CSV) of Chrome, Firefox,
// Safari, Bitwarden or 1Password. The file's text lives only in this dialog's
// state, goes only to the user's own node, and is dropped when the import
// finishes or the dialog closes. Nothing is saved before the user confirms,
// and a saved login is replaced only when the user selects it.

import { useLiteralMessages } from "@ryu/i18n/react";
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
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	applyLoginImport,
	LOGIN_IMPORT_MAX_BYTES,
	type LoginImportPreview,
	type LoginImportResult,
	previewLoginImport,
} from "@/src/lib/api/vault-login-import.ts";
import {
	droppedAuthenticatorKeys,
	LOGIN_IMPORT_FORMAT_NAMES,
	LOGIN_IMPORT_LIST_LIMIT,
	loginImportChoices,
	loginImportErrorMessage,
	loginImportOutcomeCount,
	loginImportProblem,
	loginImportRows,
} from "./vault-login-import.ts";

function ImportResult({ result }: { result: LoginImportResult }) {
	const tl = useLiteralMessages();
	const denied = loginImportOutcomeCount(result, "denied");
	const conflicts = loginImportOutcomeCount(result, "conflict");
	return (
		<div className="space-y-2 text-sm" role="status">
			<p className="font-medium">Import finished</p>
			<p>
				{tl("{created} added, {replaced} replaced, {skipped} skipped", {
					created: result.created,
					replaced: result.replaced,
					skipped: result.skipped,
				})}
			</p>
			{denied > 0 ? (
				<p>
					{tl("Records you do not have permission to save: {count}", {
						count: denied,
					})}
				</p>
			) : null}
			{conflicts > 0 ? (
				<p>
					{tl(
						"Logins that changed since the preview and were not replaced: {count}",
						{ count: conflicts }
					)}
				</p>
			) : null}
			<p className="rounded-lg border p-3">
				{tl(
					"Delete the export file now. It holds your passwords as plain text, and Ryu does not delete or change it."
				)}
			</p>
		</div>
	);
}

function ImportPreview({
	onToggle,
	preview,
	replaceRows,
}: {
	onToggle: (row: number, selected: boolean) => void;
	preview: LoginImportPreview;
	replaceRows: ReadonlySet<number>;
}) {
	const tl = useLiteralMessages();
	const duplicates = loginImportRows(preview, "duplicate");
	const invalid = loginImportRows(preview, "invalid");
	const dropped = droppedAuthenticatorKeys(preview);
	const more = (hidden: number) =>
		hidden > 0 ? (
			<p className="text-muted-foreground text-xs">
				{tl("{count} more not shown.", { count: hidden })}
			</p>
		) : null;
	return (
		<div className="space-y-3 text-sm">
			<p>
				{tl("Records read from the {format} export: {total}", {
					format: tl(LOGIN_IMPORT_FORMAT_NAMES[preview.format]),
					total: preview.counts.total,
				})}
			</p>
			<p>
				{tl("New logins to add to the {environment} environment: {count}", {
					count: preview.counts.new,
					environment: preview.environment,
				})}
			</p>
			{duplicates.length > 0 ? (
				<div className="space-y-2">
					<p>
						{tl(
							"Logins already saved: {count}. Select the ones whose password you want to replace. The rest are skipped.",
							{ count: preview.counts.duplicate }
						)}
					</p>
					<ul className="max-h-48 divide-y overflow-y-auto rounded-lg border">
						{duplicates.slice(0, LOGIN_IMPORT_LIST_LIMIT).map((row) => (
							<li className="flex items-center gap-3 px-3 py-2" key={row.row}>
								<Checkbox
									aria-label={tl(
										"Replace the saved password for {username} on {site}",
										{ site: row.host ?? "", username: row.username ?? "" }
									)}
									checked={replaceRows.has(row.row)}
									onCheckedChange={(checked: boolean) =>
										onToggle(row.row, checked)
									}
								/>
								<div className="min-w-0" data-ryu-i18n="off">
									<p className="truncate">{row.host}</p>
									<p className="truncate text-muted-foreground text-xs">
										{row.username}
									</p>
								</div>
							</li>
						))}
					</ul>
					{more(duplicates.length - LOGIN_IMPORT_LIST_LIMIT)}
				</div>
			) : null}
			{preview.counts.repeated > 0 ? (
				<p>
					{tl(
						"Records that repeat an earlier one and will be skipped: {count}",
						{ count: preview.counts.repeated }
					)}
				</p>
			) : null}
			{invalid.length > 0 ? (
				<div className="space-y-2">
					<p>
						{tl(
							"Records that cannot be imported and will be skipped: {count}",
							{ count: preview.counts.invalid }
						)}
					</p>
					<ul className="max-h-32 overflow-y-auto text-muted-foreground text-xs">
						{invalid.slice(0, LOGIN_IMPORT_LIST_LIMIT).map((row) => (
							<li key={row.row}>
								{tl("Record {row}: {reason}", {
									reason: loginImportProblem(row.problem, tl),
									row: row.row,
								})}
							</li>
						))}
					</ul>
					{more(invalid.length - LOGIN_IMPORT_LIST_LIMIT)}
				</div>
			) : null}
			{dropped > 0 ? (
				<p>
					{tl(
						"Authenticator keys that cannot be used and will be left out: {count}",
						{ count: dropped }
					)}
				</p>
			) : null}
			<p className="text-muted-foreground text-xs">
				{tl(
					"Imported logins are sealed like any other item. An agent can fill one only after you attach it to the browser session of that agent."
				)}
			</p>
		</div>
	);
}

function ImportBody({
	environment,
	onClose,
	target,
}: {
	environment: string;
	onClose: () => void;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const queryClient = useQueryClient();
	// The file's text. Kept out of React Query: its cache would keep it.
	const [csv, setCsv] = useState<string | null>(null);
	const [preview, setPreview] = useState<LoginImportPreview | null>(null);
	const [replaceRows, setReplaceRows] = useState<ReadonlySet<number>>(
		new Set()
	);
	const [result, setResult] = useState<LoginImportResult | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) {
			return;
		}
		setError(null);
		setPreview(null);
		setCsv(null);
		setReplaceRows(new Set());
		if (file.size > LOGIN_IMPORT_MAX_BYTES) {
			setError(
				tl("This file is too large to import. Split it and import the parts.")
			);
			return;
		}
		setPending(true);
		try {
			const text = await file.text();
			setPreview(await previewLoginImport(target, text, { environment }));
			setCsv(text);
		} catch (caught) {
			setError(loginImportErrorMessage(caught, tl));
		} finally {
			setPending(false);
		}
	};

	const choices = preview
		? loginImportChoices(preview, replaceRows)
		: { replace: [], rows: [] };
	const chosen = choices.rows.length + choices.replace.length;

	const submit = async () => {
		if (csv === null) {
			return;
		}
		setError(null);
		setPending(true);
		try {
			setResult(
				await applyLoginImport(target, { csv, environment, ...choices })
			);
			setCsv(null);
			setPreview(null);
			await queryClient.invalidateQueries({ queryKey: ["vault", "items"] });
		} catch (caught) {
			setError(loginImportErrorMessage(caught, tl));
		} finally {
			setPending(false);
		}
	};

	const toggle = (row: number, selected: boolean) => {
		setReplaceRows((current) => {
			const next = new Set(current);
			if (selected) {
				next.add(row);
			} else {
				next.delete(row);
			}
			return next;
		});
	};

	if (result) {
		return (
			<>
				<ImportResult result={result} />
				<DialogFooter>
					<Button onClick={onClose} variant="mono">
						Done
					</Button>
				</DialogFooter>
			</>
		);
	}
	return (
		<>
			<input
				accept=".csv,text/csv"
				aria-label={tl("Password export file")}
				className="max-w-full text-xs file:me-2 file:rounded-full file:border-0 file:bg-muted file:px-3 file:py-1 file:text-xs"
				disabled={pending}
				id="vault-login-import-file"
				onChange={readFile}
				type="file"
			/>
			{preview ? (
				<ImportPreview
					onToggle={toggle}
					preview={preview}
					replaceRows={replaceRows}
				/>
			) : null}
			{error ? (
				<p className="text-sm text-status-destructive" role="alert">
					{error}
				</p>
			) : null}
			<DialogFooter>
				<Button onClick={onClose} variant="ghost">
					Cancel
				</Button>
				<Button
					disabled={pending || csv === null || chosen === 0}
					loading={pending}
					onClick={submit}
					variant="mono"
				>
					Import logins
				</Button>
			</DialogFooter>
		</>
	);
}

export function VaultLoginImportDialog({
	environment,
	onOpenChange,
	open,
	target,
}: {
	environment: string;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import logins</DialogTitle>
					<DialogDescription>
						{tl(
							"Choose a CSV password export from Chrome, Firefox, Safari, Bitwarden or 1Password. Nothing is saved until you select Import logins."
						)}
					</DialogDescription>
				</DialogHeader>
				{open ? (
					<ImportBody
						environment={environment}
						onClose={() => onOpenChange(false)}
						target={target}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
