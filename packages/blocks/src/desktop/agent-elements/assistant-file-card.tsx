// An assistant `file` part that is not an image, a video or an audio clip,
// drawn as a file card.
//
// The bytes travel inside the message (a `data:` URL), so Download works with
// no request to the node and still works after a reload. Open is offered for
// text files only: the artifact panel shows their content. Other types have
// no in-app viewer without a stored Space file, so they get no Open button.
//
// A part whose URL is a web address or a path is never read. No agent runtime
// sends one, and an address the agent chose is not fetched on a click. Such a
// part shows the card in its unavailable state, with Download off.

import { useCallback, useMemo } from "react";
import { useArtifactHost } from "./artifact-host-context.tsx";
import type { AssistantFileMeta } from "./assistant-file-meta.ts";
import { FileCard, type FileCardProps } from "./file-card.tsx";
import { blobFromFileUrl, isInlineFileUrl } from "./file-card-download.ts";
import { dataUrlByteSize, isTextLikeFile } from "./file-card-logic.ts";

/** Largest text file Open reads into the artifact panel. */
export const MAX_OPEN_TEXT_BYTES = 2 * 1024 * 1024;

export interface AssistantFileCardProps {
	className?: string;
	file: AssistantFileMeta;
	/** Stable id of the part; the panel that Open shows is keyed by it. */
	id: string;
	/** Hands the bytes to the browser as a download. Tests replace it. */
	save?: FileCardProps["save"];
}

function knownSize(file: AssistantFileMeta): number | undefined {
	const declared = file.size;
	if (declared !== undefined && Number.isFinite(declared) && declared >= 0) {
		return declared;
	}
	return dataUrlByteSize(file.url);
}

export function AssistantFileCard({
	className,
	file,
	id,
	save,
}: AssistantFileCardProps) {
	const host = useArtifactHost();
	const { filename, media, url } = file;
	const size = knownSize(file);
	const readable = isInlineFileUrl(url);
	const loadBlob = useMemo(
		() => (readable ? () => blobFromFileUrl(url) : undefined),
		[readable, url]
	);

	const canOpen =
		host !== null &&
		readable &&
		isTextLikeFile(filename, media) &&
		size !== undefined &&
		size <= MAX_OPEN_TEXT_BYTES;
	const open = useCallback(async () => {
		const blob = await blobFromFileUrl(url);
		if (!(blob && host)) {
			return;
		}
		host.openInPanel(
			{ content: await blob.text(), mime: media, title: filename },
			id
		);
	}, [filename, host, id, media, url]);

	return (
		<FileCard
			className={className}
			loadBlob={loadBlob}
			mime={media}
			name={filename}
			onOpen={
				canOpen
					? () => {
							open().catch(() => undefined);
						}
					: undefined
			}
			save={save}
			size={size}
		/>
	);
}
