interface InboxCenterProofApi {
	recordExternalUrl(url: string): void;
}

declare global {
	interface Window {
		__inboxCenterProof: InboxCenterProofApi;
	}
}

export async function openExternal(url: string): Promise<void> {
	window.__inboxCenterProof.recordExternalUrl(url);
}

export async function openTabWindow(): Promise<void> {}
