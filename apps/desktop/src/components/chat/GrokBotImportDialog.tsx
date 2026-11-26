// apps/desktop/src/components/chat/GrokBotImportDialog.tsx
//
// Bring bots over from xAI's Grok Bot, which has no export. The dialog hands
// the user a migrator prompt to paste into a chat with a bot there. That bot
// packs the user's bots (instructions, memories, skills, files, chats) into
// one zip file. The user chooses the zip here, Core checks it and answers
// with a preview, and nothing is imported until the user confirms.

import {
	Copy01Icon,
	Download01Icon,
	FolderOpenIcon,
} from "@hugeicons/core-free-icons";
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
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { type ChangeEvent, useRef, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import { type ImportOutcome, runImport } from "@/src/lib/api/import.ts";
import {
	type ArchiveBot,
	ArchiveRefusedError,
	archiveTotals,
	discardImportArchive,
	type StagedArchive,
	stageImportArchive,
} from "@/src/lib/api/import-archive.ts";
import { GROK_BOT_MIGRATOR_PROMPT } from "@/src/lib/grok-bot-migrator.ts";
import { scanWarnings } from "@/src/lib/import-scan-text.ts";
import { importOutcomeLine } from "./import-outcome-text.ts";

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-lg bg-muted px-3 py-2">
			<dt className="truncate text-muted-foreground text-xs">{label}</dt>
			<dd className="font-medium text-foreground text-lg tabular-nums">
				{value}
			</dd>
		</div>
	);
}

function BotStat({ label, value }: { label: string; value: number }) {
	return (
		<span>
			{label} <span className="tabular-nums">{value}</span>
		</span>
	);
}

function BotRow({ bot }: { bot: ArchiveBot }) {
	const tl = useLiteralMessages();
	return (
		<li className="flex flex-col gap-0.5 rounded-lg px-3 py-2">
			<span className="truncate font-medium text-foreground text-sm">
				{bot.name}
			</span>
			{bot.description && (
				<span
					className="truncate text-muted-foreground text-xs"
					title={bot.description}
				>
					{bot.description}
				</span>
			)}
			<span className="flex flex-wrap gap-x-3 text-muted-foreground text-xs">
				<BotStat label={tl("Memories")} value={bot.memories} />
				<BotStat label={tl("Skills")} value={bot.skills} />
				<BotStat label={tl("Files")} value={bot.files} />
				<BotStat label={tl("Chats")} value={bot.conversations} />
			</span>
		</li>
	);
}

export function GrokBotImportDialog({
	onImported,
	onOpenChange,
	onProjectFolder,
	open,
	target,
}: {
	/** Called after an import that created at least one project folder. */
	onImported?: () => void;
	onOpenChange: (open: boolean) => void;
	/** Called with each project folder an import created or reused. */
	onProjectFolder?: (path: string) => void;
	open: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const fileInput = useRef<HTMLInputElement>(null);
	const [staged, setStaged] = useState<StagedArchive | null>(null);
	const [checking, setChecking] = useState(false);
	const [importing, setImporting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);

	// The staging folder holds a copy of the user's files on the node, so it
	// goes as soon as the dialog is done with it.
	const discard = (archive: StagedArchive | null) => {
		if (archive) {
			discardImportArchive(target, archive.scan.root).catch(() => undefined);
		}
	};

	const reset = () => {
		discard(staged);
		setStaged(null);
		setError(null);
		setOutcomes(null);
	};

	const close = () => {
		reset();
		onOpenChange(false);
	};

	const copyPrompt = async () => {
		try {
			await navigator.clipboard.writeText(GROK_BOT_MIGRATOR_PROMPT);
			toast.success(tl("Prompt copied"));
		} catch {
			toast.error(tl("Couldn't copy the prompt"));
		}
	};

	const checkFile = async (event: ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		// Clear the input so choosing the same file again fires a change.
		event.target.value = "";
		if (!file) {
			return;
		}
		reset();
		setChecking(true);
		try {
			setStaged(await stageImportArchive(target, file));
		} catch (err) {
			setError(
				(err instanceof ArchiveRefusedError && err.reason) ||
					tl("This zip file cannot be imported.")
			);
		} finally {
			setChecking(false);
		}
	};

	const runStagedImport = async () => {
		if (!staged || importing) {
			return;
		}
		setImporting(true);
		setError(null);
		try {
			const result = await runImport(
				target,
				staged.scan.root,
				staged.scan.items.map((item) => ({ id: item.id, kind: item.kind }))
			);
			setOutcomes(result.results);
			// Everything Core took is in its own stores now.
			discard(staged);
			const folders = new Set<string>();
			for (const outcome of result.results) {
				if (outcome.folderPath) {
					folders.add(outcome.folderPath);
				}
			}
			for (const folder of folders) {
				onProjectFolder?.(folder);
			}
			if (folders.size > 0) {
				onImported?.();
			}
		} catch {
			setError(tl("This zip file cannot be imported."));
		} finally {
			setImporting(false);
		}
	};

	const totals = staged ? archiveTotals(staged.archive) : null;
	const warnings = staged ? scanWarnings(staged.scan, tl) : [];
	const importedCount =
		outcomes?.filter((outcome) => outcome.status === "imported").length ?? 0;
	const failedCount =
		outcomes?.filter((outcome) => outcome.status === "failed").length ?? 0;

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!(next || importing)) {
					close();
				}
			}}
			open={open}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import from Grok Bot</DialogTitle>
					<DialogDescription>
						Grok Bot has no export of its own. A bot there can pack your bots
						into one zip file, and Ryu imports that file.
					</DialogDescription>
				</DialogHeader>

				<input
					accept=".zip,application/zip"
					className="hidden"
					data-testid="grok-bot-zip-input"
					onChange={checkFile}
					ref={fileInput}
					type="file"
				/>

				{!(staged || checking) && (
					<div className="flex flex-col gap-4 py-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="grok-bot-migrator-prompt">
								1. Copy this prompt and paste it into a chat with any bot in
								Grok Bot.
							</Label>
							<Textarea
								className="max-h-32"
								id="grok-bot-migrator-prompt"
								readOnly
								spellCheck={false}
								value={GROK_BOT_MIGRATOR_PROMPT}
								variant="code-caption"
							/>
							<Button
								className="self-start"
								onClick={copyPrompt}
								size="sm"
								variant="ghost"
							>
								<HugeiconsIcon className="size-4" icon={Copy01Icon} />
								Copy prompt
							</Button>
						</div>
						<p className="text-foreground text-sm">
							2. Answer its questions, then download the zip file it attaches to
							its reply.
						</p>
						<div className="flex flex-col gap-1.5">
							<p className="text-foreground text-sm">
								3. Choose that zip file here.
							</p>
							<Button
								onClick={() => fileInput.current?.click()}
								variant="secondary"
							>
								<HugeiconsIcon
									className="size-4 shrink-0"
									icon={FolderOpenIcon}
								/>
								Choose zip file
							</Button>
							<p className="text-muted-foreground text-xs">
								The file is checked before anything is imported. Sign-in files
								and keys are left out, and routines are listed but not created.
							</p>
						</div>
					</div>
				)}

				{checking && (
					<div className="flex h-48 items-center justify-center gap-3 text-muted-foreground text-sm">
						<Spinner />
						Checking the zip file…
					</div>
				)}

				{error && (
					<p
						className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-status-destructive"
						role="alert"
					>
						{error}
					</p>
				)}

				{staged && totals && (
					<div className="flex flex-col gap-3 py-2">
						<dl className="grid grid-cols-3 gap-2 sm:grid-cols-5">
							<Stat label={tl("Bots")} value={totals.bots} />
							<Stat label={tl("Memories")} value={totals.memories} />
							<Stat label={tl("Skills")} value={totals.skills} />
							<Stat label={tl("Files")} value={totals.files} />
							<Stat label={tl("Chats")} value={totals.conversations} />
						</dl>
						<ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
							{staged.archive.bots.map((bot) => (
								<BotRow bot={bot} key={bot.key} />
							))}
						</ul>
						{warnings.length > 0 && (
							<p className="text-muted-foreground text-xs">
								{warnings.join(" · ")}
							</p>
						)}
						{staged.scan.items.length === 0 && (
							<p className="text-muted-foreground text-sm">
								Nothing in this zip file can be imported.
							</p>
						)}
						{outcomes && (
							<div className="flex flex-col gap-1 text-sm">
								<p className="flex items-center gap-2 text-foreground">
									<HugeiconsIcon
										className="size-4 shrink-0"
										icon={Download01Icon}
									/>
									{tl(
										"Imported {importedCount}, skipped {skippedCount}, failed {failedCount}",
										{
											importedCount: String(importedCount),
											skippedCount: String(
												outcomes.length - importedCount - failedCount
											),
											failedCount: String(failedCount),
										}
									)}
								</p>
								{outcomes
									.filter((outcome) => outcome.status === "failed")
									.map((outcome) => (
										<p
											className="text-status-destructive text-xs"
											key={`${outcome.kind}:${outcome.id}`}
										>
											{importOutcomeLine(outcome, tl)}
										</p>
									))}
							</div>
						)}
					</div>
				)}

				<DialogFooter>
					{staged && !outcomes && (
						<Button disabled={importing} onClick={reset} variant="ghost">
							Choose another file
						</Button>
					)}
					<Button disabled={importing} onClick={close} variant="ghost">
						Close
					</Button>
					{!outcomes && (
						<Button
							disabled={!staged || staged.scan.items.length === 0}
							loading={importing}
							onClick={runStagedImport}
						>
							Import
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** The entry point shown in the Import agent setup dialog. */
export function GrokBotImportButton({
	disabled,
	onImported,
	onProjectFolder,
	target,
}: {
	disabled?: boolean;
	onImported?: () => void;
	onProjectFolder?: (path: string) => void;
	target: ApiTarget;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button disabled={disabled} onClick={() => setOpen(true)} variant="ghost">
				Import from Grok Bot
			</Button>
			<GrokBotImportDialog
				onImported={onImported}
				onOpenChange={setOpen}
				onProjectFolder={onProjectFolder}
				open={open}
				target={target}
			/>
		</>
	);
}
