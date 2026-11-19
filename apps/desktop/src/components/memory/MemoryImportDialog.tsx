// apps/desktop/src/components/memory/MemoryImportDialog.tsx
//
// Bring memories over from another AI assistant. Most assistants keep saved
// memory out of their data exports, so the dialog hands the user a prompt to
// paste into that assistant, then sends the reply to Core, which parses it,
// records each entry with import provenance and skips repeats.

import { Copy01Icon } from "@hugeicons/core-free-icons";
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
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { type ChangeEvent, useState } from "react";
import type { ApiTarget } from "@/src/lib/api/client.ts";
import {
	importPastedMemories,
	PASTE_SOURCE_LABELS,
	PASTE_SOURCES,
	type PastedMemoryImport,
	type PasteSource,
} from "@/src/lib/api/memory-import.ts";
import { memoryErrorText } from "./memory-error-text.ts";
import { MEMORY_IMPORT_PROMPT } from "./memory-import-prompt.ts";

/** One sentence describing what an import added, for the toast. */
export function importSummaryText(
	result: PastedMemoryImport,
	tl: ReturnType<typeof useLiteralMessages>
): string {
	const parts = [tl("{count} added", { count: String(result.imported) })];
	if (result.alreadyPresent > 0) {
		parts.push(
			tl("{count} already saved", { count: String(result.alreadyPresent) })
		);
	}
	if (result.skippedSensitive > 0) {
		parts.push(
			tl(
				"{count} skipped because sensitive topics are off in Settings → Memory",
				{ count: String(result.skippedSensitive) }
			)
		);
	}
	return parts.join(" · ");
}

export function MemoryImportDialog({
	onClose,
	onImported,
	open,
	target,
}: {
	onClose: () => void;
	/** Called after an import added at least one memory. */
	onImported: () => void;
	open: boolean;
	target: ApiTarget;
}) {
	const tl = useLiteralMessages();
	const [source, setSource] = useState<PasteSource>("chatgpt");
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const close = () => {
		setText("");
		setError(null);
		onClose();
	};

	const copyPrompt = async () => {
		try {
			await navigator.clipboard.writeText(MEMORY_IMPORT_PROMPT);
			toast.success(tl("Prompt copied"));
		} catch {
			toast.error(tl("Couldn't copy the prompt"));
		}
	};

	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			const result = await importPastedMemories(target, { source, text });
			const description = importSummaryText(result, tl);
			if (result.imported > 0) {
				toast.success(tl("Memories imported"), { description });
				onImported();
			} else {
				toast.info(tl("No new memories"), { description });
			}
			close();
		} catch (err) {
			setError(
				memoryErrorText(err, tl("Couldn't import these memories. Try again."))
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			onOpenChange={(next: boolean) => {
				if (!next) {
					close();
				}
			}}
			open={open}
		>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import memories</DialogTitle>
					<DialogDescription>
						Bring what another AI assistant knows about you into Ryu.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="memory-import-source">Import from</Label>
						<NativeSelect
							id="memory-import-source"
							onChange={(e: ChangeEvent<HTMLSelectElement>) =>
								setSource(e.target.value as PasteSource)
							}
							value={source}
						>
							{PASTE_SOURCES.map((value) => (
								<NativeSelectOption key={value} value={value}>
									{tl(PASTE_SOURCE_LABELS[value])}
								</NativeSelectOption>
							))}
						</NativeSelect>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="memory-import-prompt">
							{tl("1. Paste this prompt into a chat with {assistant}", {
								assistant: tl(PASTE_SOURCE_LABELS[source]),
							})}
						</Label>
						<Textarea
							className="max-h-32"
							id="memory-import-prompt"
							readOnly
							spellCheck={false}
							value={MEMORY_IMPORT_PROMPT}
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

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="memory-import-text">2. Paste the reply here</Label>
						<Textarea
							id="memory-import-text"
							onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
								setText(e.target.value)
							}
							placeholder="Paste the whole reply, code block included."
							rows={6}
							value={text}
						/>
						<p className="text-muted-foreground text-xs">
							Review it first. Each line becomes a memory you can edit or delete
							later, and lines you already imported are skipped.
						</p>
					</div>

					{error ? (
						<p className="text-sm text-status-destructive" role="alert">
							{error}
						</p>
					) : null}
				</div>

				<DialogFooter>
					<Button onClick={close} type="button" variant="ghost">
						Cancel
					</Button>
					<Button disabled={!text.trim()} loading={busy} onClick={submit}>
						Add to memory
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
