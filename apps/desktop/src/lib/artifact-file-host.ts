// apps/desktop/src/lib/artifact-file-host.ts
//
// The file half of the artifact host the chat page hands to `@ryu/blocks`. It
// reads a created file's bytes from the node and opens it in the Space
// file viewer tab. Both work the same in the desktop app and in the web app,
// which is this code in a browser.
//
// A file is addressed only through `spaceFileRef`, so the node credentials go
// to the Space document route of the chat's own node and nowhere else. Open
// never hands a file to the operating system: it opens an in-app tab.

import type { ArtifactHostValue } from "@ryu/blocks/desktop/agent-elements/artifact-host-context.tsx";
import type { ApiTarget } from "./api/client.ts";
import { artifactText, spaceFileRef } from "./artifact-files.ts";

type OpenTab = (path: string, options?: { title?: string }) => void;
/** `fetchSpaceFileBlob` in the app. Passed in, so this module stays free of
 *  the Spaces API client and its tests need no network. */
type FetchSpaceFile = (
	target: ApiTarget,
	spaceId: string,
	documentId: string
) => Promise<Blob>;

export type ArtifactFileHost = Required<
	Pick<ArtifactHostValue, "fetchBlob" | "openFile">
>;

export function artifactFileHost(
	target: ApiTarget,
	openTab: OpenTab,
	fetchFile: FetchSpaceFile
): ArtifactFileHost {
	return {
		fetchBlob: async (payload) => {
			const file = spaceFileRef(payload);
			if (!file) {
				return null;
			}
			try {
				return await fetchFile(target, file.spaceId, file.docId);
			} catch {
				return null;
			}
		},
		openFile: (payload) => {
			const file = spaceFileRef(payload);
			if (file) {
				openTab(`/spaces/${file.spaceId}/file/${file.docId}`, {
					title: artifactText(payload.title),
				});
			}
		},
	};
}
