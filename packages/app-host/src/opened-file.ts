/** Host-owned access to one explicitly opened file. Plugins cannot widen this scope. */
export interface OpenedFileAccess {
	editable: boolean;
	name: string;
	read(): Promise<OpenedFileSnapshot>;
	uri: string;
	write?(text: string, expectedRevision: string): Promise<OpenedFileSnapshot>;
	writeBlob?(
		blob: string,
		expectedRevision: string
	): Promise<OpenedFileSnapshot>;
}

export type OpenedFileSnapshot = {
	uri: string;
	revision: string;
} & ({ text: string; blob?: never } | { blob: string; text?: never });

export function assertOpenedFileUri(
	access: OpenedFileAccess | undefined,
	uri: string
): OpenedFileAccess {
	if (!access || uri !== access.uri) {
		throw new Error("Only the file opened in this panel is available");
	}
	return access;
}
