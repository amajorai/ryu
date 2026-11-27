// apps/desktop/src/components/chat/ArtifactDownloadButton.tsx
//
// Download on the inline artifact card. A created artifact is saved from its
// stored bytes (read through the artifact host). An artifact that only has
// inline content (`artifact.render`, or a created one whose bytes cannot be
// read right now) is saved from the content on screen, as plain text under a
// name that carries the ending of its kind.
//
// The browser or the desktop web view decides where the file goes. This
// component passes a Blob and a file name, never a path.

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { saveBlobAs } from "@ryu/blocks/desktop/agent-elements/file-card-download.ts";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import {
	artifactContentBlob,
	artifactDownloadName,
	type DownloadableArtifact,
} from "@/src/lib/artifact-files.ts";

export interface ArtifactDownloadButtonProps {
	artifact: DownloadableArtifact;
	/** Reads the stored bytes of a created file. Absent: the content is saved. */
	loadBlob?: () => Promise<Blob | null>;
	/** Hands the bytes to the browser as a download. Tests replace it. */
	save?: (blob: Blob, name: string) => void;
}

function saveToBrowser(blob: Blob, name: string) {
	saveBlobAs(blob, name);
}

export function ArtifactDownloadButton({
	artifact,
	loadBlob,
	save = saveToBrowser,
}: ArtifactDownloadButtonProps) {
	const [state, setState] = useState<"busy" | "failed" | "idle">("idle");
	const hasContent = artifact.content.length > 0;

	const download = async () => {
		setState("busy");
		let blob: Blob | null = null;
		try {
			blob = loadBlob ? await loadBlob() : null;
		} catch {
			blob = null;
		}
		if (!blob && hasContent) {
			blob = artifactContentBlob(artifact.content);
		}
		if (!blob) {
			setState("failed");
			return;
		}
		save(blob, artifactDownloadName(artifact));
		setState("idle");
	};

	return (
		<Button
			data-state={state}
			data-testid="artifact-download"
			disabled={state === "busy" || !(loadBlob || hasContent)}
			onClick={() => {
				download().catch(() => setState("failed"));
			}}
			size="sm"
			type="button"
			variant="ghost-muted"
		>
			<HugeiconsIcon aria-hidden className="size-4" icon={Download01Icon} />
			{state === "failed" ? "Retry" : "Download"}
		</Button>
	);
}
