import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarkdownEditor } from "@/src/components/editor/MarkdownEditor.tsx";
import { useAssistantPageContext } from "@/src/hooks/useAssistantPageContext.ts";
import {
	basename,
	readProjectFile,
	writeProjectFile,
} from "@/src/lib/files.ts";

const SAVE_DEBOUNCE_MS = 800;

/** Cap on page-context text shipped to the assistant's first message. */
const ASSISTANT_CONTEXT_CAP = 4000;

type SaveState = "idle" | "saving" | "saved" | "error";

const SAVE_LABEL = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Save failed",
} satisfies Record<SaveState, string>;

/**
 * Opens a markdown file from the active project folder in the full Plate editor
 * and autosaves (debounced) back to disk via a Tauri command. This is the
 * chat-page "edit my project files" surface; it shares the exact editor used by
 * Spaces pages, just with a filesystem backend instead of Core.
 */
export default function FileEditorPage({ filePath }: { filePath: string }) {
	const [initial, setInitial] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loadNonce, setLoadNonce] = useState(0);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	const markdownRef = useRef("");
	const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
	const currentFileRef = useRef(filePath);
	currentFileRef.current = filePath;
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let cancelled = false;
		setError(null);
		setInitial(null);
		setSaveState("idle");
		readProjectFile(filePath)
			.then((text) => {
				if (cancelled) {
					return;
				}
				markdownRef.current = text;
				setInitial(text);
			})
			.catch((e) => {
				if (!cancelled) {
					console.error("Failed to open file", e);
					setError("Something went wrong opening this file. Please try again.");
				}
			});
		return () => {
			cancelled = true;
		};
	}, [filePath, loadNonce]);

	// Offer this file as context to the global "Ask Ryu" assistant (capped so a
	// huge file never bloats the first message).
	useAssistantPageContext(
		useMemo(
			() => ({
				id: `file:${filePath}`,
				title: basename(filePath),
				text: (initial ?? "").slice(0, ASSISTANT_CONTEXT_CAP),
			}),
			[filePath, initial]
		)
	);

	const flush = useCallback(() => {
		// Capture both at enqueue time: navigation may load another file while an
		// older write is still running. Serialize writes so late disk responses
		// cannot put an earlier edit back over the latest markdown.
		const path = filePath;
		const markdown = markdownRef.current;
		const isCurrent = () =>
			currentFileRef.current === path && markdownRef.current === markdown;
		if (currentFileRef.current === path) {
			setSaveState("saving");
		}
		const save = saveQueueRef.current.then(async () => {
			try {
				await writeProjectFile(path, markdown);
				if (isCurrent()) {
					setSaveState("saved");
				}
			} catch (e) {
				if (isCurrent()) {
					setSaveState("error");
				}
				console.error("Failed to save file", e);
				toast.error("Couldn't save your changes", {
					description:
						"Something went wrong writing this file. Please try again.",
				});
			}
		});
		saveQueueRef.current = save;
		return save;
	}, [filePath]);

	const scheduleSave = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}
		setSaveState("saving");
		timerRef.current = setTimeout(() => {
			timerRef.current = null;
			flush().catch(() => undefined);
		}, SAVE_DEBOUNCE_MS);
	}, [flush]);

	useEffect(
		() => () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
				flush().catch(() => undefined);
			}
		},
		[flush]
	);

	const handleMarkdownChange = useCallback(
		(markdown: string) => {
			markdownRef.current = markdown;
			scheduleSave();
		},
		[scheduleSave]
	);

	if (error) {
		return (
			<Empty className="h-full">
				<EmptyHeader>
					<EmptyMedia variant="icon">
						<HugeiconsIcon icon={File01Icon} />
					</EmptyMedia>
					<EmptyTitle>Could not open file</EmptyTitle>
					<EmptyDescription>{error}</EmptyDescription>
				</EmptyHeader>
				<EmptyContent>
					<Button onClick={() => setLoadNonce((nonce) => nonce + 1)} size="sm">
						Try again
					</Button>
				</EmptyContent>
			</Empty>
		);
	}

	if (initial === null) {
		return <SkeletonRows rows={6} spacing="library" />;
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<HugeiconsIcon
					className="size-4 shrink-0 opacity-70"
					icon={File01Icon}
				/>
				<span
					className="min-w-0 flex-1 truncate font-medium text-sm"
					title={basename(filePath)}
				>
					{basename(filePath)}
				</span>
				{saveState === "error" ? (
					<div className="flex shrink-0 items-center gap-2">
						<span className="text-status-destructive text-xs">Save failed</span>
						<Button
							onClick={() => {
								flush().catch(() => undefined);
							}}
							size="sm"
							variant="ghost"
						>
							Retry
						</Button>
					</div>
				) : (
					<span className="shrink-0 text-muted-foreground text-xs">
						{SAVE_LABEL[saveState]}
					</span>
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				<MarkdownEditor
					initialMarkdown={initial}
					key={filePath}
					onChangeMarkdown={handleMarkdownChange}
				/>
			</div>
		</div>
	);
}
