import {
	ArrowDown01Icon,
	ArrowUpRight01Icon,
	FileCodeIcon,
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
import { Button } from "@ryu/ui/components/button";
import { formatCount } from "@ryu/ui/lib/number-format.ts";
import { safeNavigationUrl } from "@ryu/ui/lib/safe-url.ts";
import { cn } from "@ryu/ui/lib/utils";
import { Undo2Icon } from "lucide-react";
import {
	type ComponentProps,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AgentUI } from "./agent-ui/agent-ui.tsx";
import {
	AgentUiSurfaceChip,
	useAgentUiSurfaceHost,
} from "./agent-ui/surface-context.tsx";
import { useArtifactHost } from "./artifact-host-context.tsx";
import { FileTypeIcon } from "./file-type-icon.tsx";
import { artifactIdForPart } from "./tools/artifact-tool.ts";
import type {
	ArtifactTurnEndCard,
	EditedFile,
	FileEditsTurnEndCard,
	FileEditUndoPlan,
	JsonRenderTurnEndCard,
	TurnEndCard,
} from "./turn-end-cards.ts";
import { nativeArtifactReactChild } from "./utils/native-artifact-render-abi.ts";
import type { NativeSdkValue } from "./utils/native-sdk-observation.ts";

const MAX_COLLAPSED_FILES = 3;

function countLabel(value: number): string {
	return formatCount(value) ?? "0";
}

function EditStats({ file }: { file: EditedFile }) {
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums">
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
		? `Undo changes to ${fileName(singleFile.path)}?`
		: `Undo changes to ${countLabel(card.files.length)} files?`;

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
						className="active:scale-[0.97]"
						disabled={undoComplete || Boolean(undoUnavailable)}
						onClick={onUndo}
						size="sm"
						type="button"
						variant="ghost"
					>
						{undoComplete ? "Undone" : "Undo"}
						<Undo2Icon aria-hidden className="size-3.5" />
					</Button>
				</span>
			) : null}
			{onReview ? (
				<Button
					className="active:scale-[0.97]"
					onClick={onReview}
					size="sm"
					type="button"
					variant="outline"
				>
					Review
				</Button>
			) : null}
		</div>
	);
}

function FileEditsCard({
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
					className="flex items-center gap-3 rounded-2xl border border-border/80 bg-card px-4 py-3 shadow-sm"
					data-layout="single"
					data-slot="turn-file-edits-card"
				>
					<button
						aria-label={`Open ${firstFile.path}`}
						className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground shadow-xs ring-1 ring-border/60 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.97]"
						onClick={() => onOpenFile?.(firstFile.path)}
						type="button"
					>
						<FileTypeIcon className="size-5" path={firstFile.path} />
					</button>
					<div className="min-w-0">
						<h3 className="truncate font-medium text-sm" title={firstFile.path}>
							Edited {fileName(firstFile.path)}
						</h3>
						<div className="mt-1 flex items-center gap-1 font-mono text-xs tabular-nums">
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
				className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm"
				data-layout="multiple"
				data-slot="turn-file-edits-card"
			>
				<header className="flex items-center gap-3 px-4 py-3">
					<span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground shadow-xs ring-1 ring-border/60">
						<HugeiconsIcon aria-hidden className="size-6" icon={FileCodeIcon} />
					</span>
					<div className="min-w-0">
						<h3 className="font-medium text-base leading-tight">
							Edited {countLabel(card.files.length)}{" "}
							{card.files.length === 1 ? "file" : "files"}
						</h3>
						<div className="mt-1 flex items-center gap-2 font-mono text-sm tabular-nums">
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
				<div className="border-border/70 border-t">
					{files.map((file) => (
						<button
							className="flex w-full items-center gap-3 border-border/50 border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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
							className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm transition-colors hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
							onClick={() => setExpanded(true)}
							type="button"
						>
							<span>
								Show {countLabel(remaining)} more{" "}
								{remaining === 1 ? "file" : "files"}
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
							className="flex w-full items-center gap-2 px-4 py-3 text-left text-muted-foreground text-sm transition-colors hover:bg-muted/45 focus-visible:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
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

function JsonRenderCard({
	card,
	onSubmit,
}: {
	card: JsonRenderTurnEndCard;
	onSubmit?: ComponentProps<typeof AgentUI>["onSubmit"];
}) {
	const surfaceHost = useAgentUiSurfaceHost();
	if (surfaceHost) {
		return (
			<AgentUiSurfaceChip
				host={surfaceHost}
				surface={{
					format: card.format,
					// The render's tool call id when known, so the chip names the same
					// render the host tracks (`deriveLiveAgentUiSurface`).
					id: card.toolCallId ?? card.id,
					spec: card.spec,
					title: card.title,
				}}
			/>
		);
	}
	return (
		<section
			className="overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm"
			data-slot="turn-json-render-card"
		>
			<header className="flex items-center gap-2 border-border/70 border-b px-4 py-3">
				<span className="type-compact rounded-lg bg-primary/10 px-2 py-1 font-mono text-primary uppercase tracking-eyebrow">
					{card.format === "a2ui" ? "A2UI" : "JSON UI"}
				</span>
				{card.title ? (
					<h3 className="min-w-0 truncate font-medium text-sm">{card.title}</h3>
				) : null}
			</header>
			<div className="p-3">
				<AgentUI
					format={card.format}
					onSubmit={onSubmit}
					persistKey={card.toolCallId}
					persistTitle={card.title}
					spec={card.spec}
				/>
			</div>
		</section>
	);
}

function safeArtifactUrl(value: NativeSdkValue): string | undefined {
	return safeNavigationUrl(value) ?? undefined;
}

function ArtifactCard({ card }: { card: ArtifactTurnEndCard }) {
	const host = useArtifactHost();
	if (host) {
		const Renderer = host.Renderer;
		// The inline tool row's id, so the page keeps the state saved while the
		// turn was streaming and opens the same panel/tab.
		const artifactId = card.toolCallId
			? artifactIdForPart(card.toolCallId)
			: card.id;
		return (
			<div className="w-full" data-slot="turn-artifact-card">
				<Renderer artifact={card.artifact} id={artifactId} />
			</div>
		);
	}
	const url = safeArtifactUrl(card.artifact.url);
	return (
		<section
			className="flex items-center gap-3 rounded-2xl border border-border/80 bg-card px-4 py-3 shadow-sm"
			data-slot="turn-artifact-card"
		>
			<HugeiconsIcon
				aria-hidden
				className="size-5 shrink-0 text-muted-foreground"
				icon={FileCodeIcon}
			/>
			<span className="min-w-0 flex-1 truncate font-medium text-sm">
				{nativeArtifactReactChild(card.artifact.title ?? "Artifact")}
			</span>
			{url ? (
				<a
					className={cn(
						"inline-flex shrink-0 items-center gap-1 text-primary text-sm hover:underline"
					)}
					href={url}
					rel="noopener noreferrer"
					target="_blank"
				>
					Open
					<HugeiconsIcon
						aria-hidden
						className="size-3.5"
						icon={ArrowUpRight01Icon}
					/>
				</a>
			) : null}
		</section>
	);
}

export function TurnEndCards({
	cards,
	onAgentUiSubmit,
	onOpenFile,
	onReviewFileEdits,
	onUndoFileEdits,
}: {
	cards: TurnEndCard[];
	onAgentUiSubmit?: ComponentProps<typeof AgentUI>["onSubmit"];
	onOpenFile?: (path: string) => void;
	onReviewFileEdits?: (paths: string[]) => void;
	onUndoFileEdits?: (plan: FileEditUndoPlan) => Promise<void>;
}) {
	if (cards.length === 0) {
		return null;
	}
	return (
		<div
			className="flex w-full max-w-full flex-col gap-3"
			data-slot="turn-end-cards"
		>
			{cards.map((card) => {
				if (card.kind === "file-edits") {
					return (
						<FileEditsCard
							card={card}
							key={card.id}
							onOpenFile={onOpenFile}
							onReview={onReviewFileEdits}
							onUndo={onUndoFileEdits}
						/>
					);
				}
				if (card.kind === "json-render") {
					return (
						<JsonRenderCard
							card={card}
							key={card.id}
							onSubmit={onAgentUiSubmit}
						/>
					);
				}
				return <ArtifactCard card={card} key={card.id} />;
			})}
		</div>
	);
}
