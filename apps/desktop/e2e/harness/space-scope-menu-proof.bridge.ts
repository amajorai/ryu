import type { Space } from "@/src/lib/api/spaces.ts";

export interface SpaceScopeMenuProofBridge {
	getSpace: () => Space | null;
	onFileStored: (spaceId: string) => void;
	onReload: () => void;
}

export function getSpaceScopeMenuProofBridge(): SpaceScopeMenuProofBridge {
	const host =
		/* SAFETY: The owning ScopeMenuProof render publishes these three private callbacks; the existing missing-holder guard remains before return. This is a callback holder view, not validation of the persisted Space output. */ window as Window & {
			__SPACE_SCOPE_MENU_PROOF__?: SpaceScopeMenuProofBridge;
		};
	const bridge = host.__SPACE_SCOPE_MENU_PROOF__;
	if (!bridge) {
		throw new Error("Space scope proof fixture has not been initialized");
	}
	return bridge;
}
