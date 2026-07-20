import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ryu/ui/components/empty";
import { toast } from "@ryu/ui/components/sileo";
import { Spinner } from "@ryu/ui/components/spinner";
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

const SAVE_LABEL: Record<SaveState, string> = {
	idle: "",
	saving: "Saving…",
	saved: "Saved",
	error: "Save failed",
};

/**
 * Opens a markdown file from the active project folder in the full Plate editor
 * and autosaves (debounced) back to disk via a Tauri command. This is the
 * chat-page "edit my project files" surface; it shares the exact editor used by
 * Spaces pages, just with a filesystem backend instead of Core.
 */
export default function FileEditorPage({ filePath }: { filePath: string }) {
	const [initial, setInitial] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<SaveState>("idle");

	const markdownRef = useRef("");
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		let cancelled = false;
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
	}, [filePath]);

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

	const flush = useCallback(async () => {
		setSaveState("saving");
		try {
			await writeProjectFile(filePath, markdownRef.current);
			setSaveState("saved");
		} catch (e) {
			setSaveState("error");
			console.error("Failed to save file", e);
			toast.error("Couldn't save your changes", {
				description:
					"Something went wrong writing this file. Please try again.",
			});
		}
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
			</Empty>
		);
	}

	if (initial === null) {
		return (
			<div className="flex h-full items-center justify-center">
				<Spinner />
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col overflow-hidden">
			<div className="flex shrink-0 items-center gap-3 border-b px-4 py-2">
				<HugeiconsIcon
					className="size-4 shrink-0 opacity-70"
					icon={File01Icon}
				/>
				<span className="min-w-0 flex-1 truncate font-medium text-sm">
					{basename(filePath)}
				</span>
				{saveState === "error" ? (
					<div className="flex shrink-0 items-center gap-2">
						<span className="text-destructive text-xs">Save failed</span>
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
