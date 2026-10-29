import { uploadSpaceFile } from "@/src/lib/api/spaces.ts";
import { getSpaceScopeMenuProofBridge } from "./space-scope-menu-proof.bridge.ts";

/** Proof-only context adapter. Uploads still use the production Core client. */
export function useSpacesContext() {
	const bridge = getSpaceScopeMenuProofBridge();
	return {
		get spaces() {
			const space = bridge.getSpace();
			return space ? [space] : [];
		},
		createPage: async () => "proof-page-id",
		createDatabase: async () => "proof-database-id",
		reload: async () => bridge.onReload(),
		uploadFile: async (
			spaceId: string,
			file: File,
			opts?: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
		) => {
			const stored = await uploadSpaceFile(
				{ token: null, url: window.location.origin },
				spaceId,
				file,
				opts
			);
			bridge.onFileStored(spaceId);
			return stored;
		},
	};
}
