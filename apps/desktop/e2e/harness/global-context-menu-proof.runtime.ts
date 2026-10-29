interface GlobalContextMenuProofState {
	clipboardItems: Array<{
		pngBytes: number;
		text: string | null;
		types: string[];
	}>;
	clipboardText: string;
	clipboardTextWrites: string[];
	devtoolsToggles: number;
	externalOpenRequests: string[];
	fullscreen: boolean;
	tauriCalls: Array<{ args: unknown; command: string }>;
	viewportCaptures: number;
}

type ProofWindow = Window & {
	__RYU_GLOBAL_CONTEXT_MENU_PROOF__?: GlobalContextMenuProofState;
};

function proofState(): GlobalContextMenuProofState {
	const state =
		/* SAFETY: global-context-menu-proof.spec.ts initializes the complete private local clipboard/native-call observation state before navigation; this runtime reads that optional holder and explicitly rejects missing installation. */ (
			window as ProofWindow
		).__RYU_GLOBAL_CONTEXT_MENU_PROOF__;
	if (!state) {
		throw new Error("Global context menu proof runtime was not installed");
	}
	return state;
}

export async function invoke(
	command: string,
	args?: { label?: string }
): Promise<boolean | undefined> {
	const state = proofState();
	state.tauriCalls.push({ args: args ?? null, command });
	if (command === "is_fullscreen") {
		return state.fullscreen;
	}
	if (command === "toggle_fullscreen") {
		state.fullscreen = !state.fullscreen;
		return state.fullscreen;
	}
	if (command === "toggle_devtools") {
		state.devtoolsToggles += 1;
		return undefined;
	}
	throw new Error(`Unexpected native command in local proof: ${command}`);
}

export async function openExternal(url: string): Promise<void> {
	proofState().externalOpenRequests.push(url);
}

export async function getCurrentWebviewWindow() {
	return {
		onResized: async () => () => undefined,
	};
}

export default async function captureLocalViewport(): Promise<HTMLCanvasElement> {
	proofState().viewportCaptures += 1;
	const canvas = document.createElement("canvas");
	canvas.toBlob = (callback: BlobCallback) => {
		callback(new Blob(["local viewport fixture"], { type: "image/png" }));
	};
	return canvas;
}
