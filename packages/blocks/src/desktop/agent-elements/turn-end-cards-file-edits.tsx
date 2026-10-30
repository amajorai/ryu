// The "Edited N files" card at the end of a turn, with its Review and Undo
// actions and the confirm dialog. Split out of turn-end-cards.tsx, which renders
// it alongside the JSON UI and artifact cards.

import {
	ArrowDown01Icon,
	FileCodeIcon,
	Undo02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
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
import { Button } from "@ryu/ui/components/button";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileTypeIcon } from "./file-type-icon.tsx";
import type {
	EditedFile,
	FileEditsTurnEndCard,
	FileEditUndoPlan,
} from "./turn-end-cards.ts";

const MAX_COLLAPSED_FILES = 3;

function countLabel(value: number): string {
	return formatCount(value) ?? "0";
}

function EditStats({ file }: { file: EditedFile }) {
	return (
		<span className="flex shrink-0 items-center gap-1 text-xs tabular-nums">
			{file.insertions > 0 ? (
				<span className="text-status-success">
					+{countLabel(file.insertions)}
				</span>
			) : null}
			{file.deletions > 0 ? (
				<span className="text-status-destructive">
					-{countLabel(file.deletions)}
				</span>
			) : null}
		</span>
	);
}

function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function UndoFileEditsDialog({
	card,
	disabled,
	onOpenChange,
	onUndo,
	open,
}: {
	card: FileEditsTurnEndCard;
	disabled: boolean;
	onOpenChange: (open: boolean) => void;
	onUndo: (plan: FileEditUndoPlan) => Promise<void>;
	open: boolean;
}) {
	const tl = useLiteralMessages();
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const owner = useMemo(() => ({ onUndo, cardId: card.id }), [onUndo, card.id]);
	const ownerRef = useRef(owner);
	ownerRef.current = owner;
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (ownerRef.current !== owner) {
			return;
		}
		setPending(false);
		setError(null);
	}, [owner]);

	const singleFile = card.files.length === 1 ? card.files[0] : undefined;
	const title = singleFile
		? tl("Undo changes to {name}?", { name: fileName(singleFile.path) })
		: tl("Undo changes to {count} files?", {
				count: countLabel(card.files.length),
			});

	const handleOpenChange = (nextOpen: boolean) => {
		if (pending) {
			return;
		}
		if (!nextOpen) {
			setError(null);
		}
		onOpenChange(nextOpen);
	};

	const handleConfirm = async () => {
		if (pending) {
			return;
		}
		const ownsResult = () => mounted.current && ownerRef.current === owner;
		setPending(true);
		setError(null);
		try {
			if (!card.undoPlan) {
				throw new Error("This turn does not have a reversible text-edit plan.");
			}
			await onUndo(card.undoPlan);
			if (ownsResult()) {
				onOpenChange(false);
			}
		} catch (caught) {
			if (!ownsResult()) {
				return;
			}
			setError(
				caught instanceof Error
					? caught.message
					: "The file edits could not be undone."
			);
		} finally {
			if (ownsResult()) {
				setPending(false);
			}
		}
	};

	return (
		<AlertDialog onOpenChange={handleOpenChange} open={open}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>{title}</AlertDialogTitle>
					<AlertDialogDescription>
						Undo only the reversible text edits from this turn. If any affected
						text changed afterward or is staged, no files will be changed.
					</AlertDialogDescription>
				</AlertDialogHeader>
				{error ? (
					<p className="text-sm text-status-destructive" role="alert">
						{error}
					</p>
				) : null}
				<AlertDialogFooter>
					<AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={disabled || pending}
						onClick={(event) => {
							event.preventDefault();
							void handleConfirm();
						}}
						variant="destructive"
					>
						{pending ? "Undoing…" : "Undo changes"}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

function FileEditActions({
	onReview,
	onUndo,
	undoUnavailable,
	undoComplete,
}: {
	onReview?: () => void;
	onUndo?: () => void;
	undoUnavailable?: string;
	undoComplete: boolean;
}) {
	if (!(onReview || onUndo || undoUnavailable)) {
		return null;
	}

	return (
		<div className="ml-auto flex shrink-0 items-center gap-2">
			{onUndo || undoUnavailable ? (
				<span title={undoUnavailable}>
					<Button
						aria-label={undoUnavailable ?? "Undo this turn's text edits"}
						disabled={undoComplete || Boolean(undoUnavailable)}
						onClick={onUndo}
						size="sm"
						type="button"
						variant="ghost"
					>
						{undoComplete ? "Undone" : "Undo"}
						<HugeiconsIcon aria-hidden className="size-3.5" icon={Undo02Icon} />
					</Button>
				</span>
			) : null}
			{onReview ? (
				<Button onClick={onReview} size="sm" type="button" variant="outline">
					Review
				</Button>
			) : null}
		</div>
	);
}

export function FileEditsCard({
	card,
	onOpenFile,
	onReview,
	onUndo,
}: {
	card: FileEditsTurnEndCard;
	onOpenFile?: (path: string) => void;
	onReview?: (paths: string[]) => void;
	onUndo?: (plan: FileEditUndoPlan) => Promise<void>;
}) {
	const tl = useLiteralMessages();
	const [expanded, setExpanded] = useState(false);
	const [undoDialogOpen, setUndoDialogOpen] = useState(false);
	const [undoComplete, setUndoComplete] = useState(false);
	const undoOwner = useMemo(
		() => ({ onUndo, cardId: card.id }),
		[onUndo, card.id]
	);
	const undoOwnerRef = useRef(undoOwner);
	undoOwnerRef.current = undoOwner;
	const undoMounted = useRef(true);
	useEffect(() => {
		undoMounted.current = true;
		return () => {
			undoMounted.current = false;
		};
	}, []);
	useEffect(() => {
		if (undoOwnerRef.current !== undoOwner) {
			return;
		}
		setUndoDialogOpen(false);
		setUndoComplete(false);
	}, [undoOwner]);
	const completeUndo = useCallback(
		async (plan: FileEditUndoPlan) => {
			if (!onUndo) {
				return;
			}
			await onUndo(plan);
			if (undoMounted.current && undoOwnerRef.current === undoOwner) {
				setUndoComplete(true);
			}
		},
		[onUndo, undoOwner]
	);

	const files = expanded
		? card.files
		: card.files.slice(0, MAX_COLLAPSED_FILES);
	const remaining = card.files.length - files.length;
	const totalInsertions = card.files.reduce(
		(total, file) => total + file.insertions,
		0
	);
	const totalDeletions = card.files.reduce(
		(total, file) => total + file.deletions,
		0
	);
	const firstFile = card.files[0];
	const isSingleFile = card.files.length === 1 && firstFile;
	const actions = (
		<FileEditActions
			onReview={
				onReview
					? () => onReview(card.files.map((file) => file.path))
					: undefined
			}
			onUndo={
				onUndo && card.undoPlan ? () => setUndoDialogOpen(true) : undefined
			}
			undoComplete={undoComplete}
			undoUnavailable={
				onUndo && !card.undoPlan
					? "Undo is available only when every change in the turn is an exact text replacement."
					: undefined
			}
		/>
	);
	const undoDialog =
		onUndo && card.undoPlan ? (
			<UndoFileEditsDialog
				card={card}
				disabled={undoComplete}
				onOpenChange={setUndoDialogOpen}
				onUndo={completeUndo}
				open={undoDialogOpen}
			/>
		) : null;

	if (isSingleFile) {
		return (
			<>
				<section
					className="flex items-center gap-3 rounded-xl border border-border px-4 py-3"
					data-layout="single"
					data-slot="turn-file-edits-card"
				>
					<button
						aria-label={tl("Open {path}", { path: firstFile.path })}
						className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors duration-150 hover:bg-accent hover:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						onClick={() => onOpenFile?.(firstFile.path)}
						type="button"
					>
						<FileTypeIcon className="size-5" path={firstFile.path} />
					</button>
					<div className="min-w-0">
						<h3 className="truncate font-medium text-sm" title={firstFile.path}>
							{tl("Edited {name}", { name: fileName(firstFile.path) })}
						</h3>
						<div className="mt-1 flex items-center gap-1 text-xs tabular-nums">
							<span className="text-status-success">
								+{countLabel(firstFile.insertions)}
							</span>
							<span className="text-status-destructive">
								-{countLabel(firstFile.deletions)}
							</span>
						</div>
					</div>
					{actions}
				</section>
				{undoDialog}
			</>
		);
	}

	return (
		<>
			<section
				className="overflow-hidden rounded-xl border border-border"
				data-layout="multiple"
				data-slot="turn-file-edits-card"
			>
				<header className="flex items-center gap-3 px-4 py-3">
					<span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
						<HugeiconsIcon aria-hidden className="size-5" icon={FileCodeIcon} />
					</span>
					<div className="min-w-0">
						<h3 className="truncate font-medium text-sm">
							{tl(
								"{count, plural, one {Edited {countText} file} other {Edited {countText} files}}",
								{
									count: card.files.length,
									countText: countLabel(card.files.length),
								}
							)}
						</h3>
						<div className="mt-1 flex items-center gap-2 text-xs tabular-nums">
							<span className="text-status-success">
								+{countLabel(totalInsertions)}
							</span>
							<span className="text-status-destructive">
								-{countLabel(totalDeletions)}
							</span>
						</div>
					</div>
					{actions}
				</header>
				<div className="border-border border-t">
					{files.map((file) => (
						<button
							className="flex h-10 w-full items-center gap-3 border-border border-b px-4 text-left transition-colors duration-150 last:border-b-0 hover:bg-muted hover:duration-0 focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							key={file.path}
							onClick={() => onOpenFile?.(file.path)}
							type="button"
						>
							<FileTypeIcon className="size-4" path={file.path} />
							<span
								className="min-w-0 flex-1 truncate font-mono text-sm"
								title={file.path}
							>
								{file.path}
							</span>
							<EditStats file={file} />
						</button>
					))}
					{remaining > 0 ? (
						<button
							aria-expanded={expanded}
							className="flex h-10 w-full items-center gap-2 px-4 text-left text-muted-foreground text-sm transition-colors duration-150 hover:bg-muted hover:text-foreground hover:duration-0 focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							onClick={() => setExpanded(true)}
							type="button"
						>
							<span>
								{tl(
									"{count, plural, one {Show {countText} more file} other {Show {countText} more files}}",
									{ count: remaining, countText: countLabel(remaining) }
								)}
							</span>
							<HugeiconsIcon
								aria-hidden
								className="size-4"
								icon={ArrowDown01Icon}
							/>
						</button>
					) : expanded && card.files.length > MAX_COLLAPSED_FILES ? (
						<button
							aria-expanded={expanded}
							className="flex h-10 w-full items-center gap-2 px-4 text-left text-muted-foreground text-sm transition-colors duration-150 hover:bg-muted hover:text-foreground hover:duration-0 focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							onClick={() => setExpanded(false)}
							type="button"
						>
							<span>Show fewer files</span>
							<HugeiconsIcon
								aria-hidden
								className="size-4 rotate-180"
								icon={ArrowDown01Icon}
							/>
						</button>
					) : null}
				</div>
			</section>
			{undoDialog}
		</>
	);
}
