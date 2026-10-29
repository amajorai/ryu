import type {
	OpenedFileAccess,
	OpenedFileSnapshot,
} from "@ryu/app-host/opened-file";
import type { PluginCompanion, PluginFileHandler } from "./api/plugins.ts";
import {
	basename,
	readProjectFile,
	readProjectFileBinary,
	writeProjectFileBinary,
} from "./files.ts";

export function ownedCompanionId(
	id: string,
	plugin: string,
	companions: PluginCompanion[]
): string | undefined {
	return companions.find(
		(companion) =>
			companion.pluginId === plugin &&
			(companion.id === id || companion.id === `app__${id}`)
	)?.id;
}

export function fileHandlersFor(
	path: string,
	handlers: PluginFileHandler[],
	companions: PluginCompanion[]
): PluginFileHandler[] {
	const name = basename(path).toLowerCase();
	return handlers.filter(
		(handler) =>
			handler.extensions.some((extension) =>
				name.endsWith(`.${extension.toLowerCase().replace(/^\./, "")}`)
			) && ownedCompanionId(handler.companion, handler.plugin, companions)
	);
}

export interface OpenedFileIO {
	read(path: string): Promise<string>;
	readBinary?(path: string): Promise<string>;
	write(path: string, text: string): Promise<void>;
	writeBinary?(path: string, blob: string): Promise<void>;
}

const openedFileWriteQueues = new Map<string, Promise<unknown>>();

export function encodeOpenedFileText(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32_768) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
	}
	return btoa(binary);
}
function queueOpenedFileWrite<T>(
	path: string,
	write: () => Promise<T>
): Promise<T> {
	const operation = (openedFileWriteQueues.get(path) ?? Promise.resolve()).then(
		write
	);
	const settled = operation.catch(() => undefined);
	openedFileWriteQueues.set(path, settled);
	void settled.finally(() => {
		if (openedFileWriteQueues.get(path) === settled) {
			openedFileWriteQueues.delete(path);
		}
	});
	return operation;
}

/** Content-derived revisions detect external changes before a save. */
export async function openedFileRevision(text: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text)
	);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

export function createOpenedFileAccess(
	path: string,
	editable: boolean,
	io: OpenedFileIO = {
		read: readProjectFile,
		write: (filePath, text) =>
			writeProjectFileBinary(filePath, encodeOpenedFileText(text)),
		readBinary: readProjectFileBinary,
		writeBinary: writeProjectFileBinary,
	}
): OpenedFileAccess {
	const uri = `host-resource://${crypto.randomUUID()}`;
	const read = async (): Promise<OpenedFileSnapshot> => {
		if (io.readBinary) {
			const blob = await io.readBinary(path);
			const bytes = Uint8Array.from(atob(blob), (character) =>
				character.charCodeAt(0)
			);
			const hash = await crypto.subtle.digest("SHA-256", bytes);
			const revision = Array.from(new Uint8Array(hash), (byte) =>
				byte.toString(16).padStart(2, "0")
			).join("");
			try {
				return {
					uri,
					revision,
					text: new TextDecoder("utf-8", {
						fatal: true,
						ignoreBOM: true,
					}).decode(bytes),
				};
			} catch {
				return { uri, revision, blob };
			}
		}
		const text = await io.read(path);
		if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) {
			throw new Error("File content exceeds the 8 MiB editor limit");
		}
		return { uri, text, revision: await openedFileRevision(text) };
	};
	return {
		uri,
		name: basename(path),
		editable,
		read,
		write: editable
			? (text, expectedRevision) => {
					return queueOpenedFileWrite(path, async () => {
						if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) {
							throw new Error("File content exceeds the 8 MiB editor limit");
						}
						const current = await read();
						if (current.revision !== expectedRevision) {
							throw new Error(
								"This file changed on disk. Read the current version before saving again."
							);
						}
						await io.write(path, text);
						return await read();
					});
				}
			: undefined,
		writeBlob:
			editable && io.writeBinary
				? (blob, expectedRevision) => {
						return queueOpenedFileWrite(path, async () => {
							if (
								blob.length > 12 * 1024 * 1024 ||
								atob(blob).length > 8 * 1024 * 1024
							) {
								throw new Error("File content exceeds the 8 MiB editor limit");
							}
							const current = await read();
							if (current.revision !== expectedRevision) {
								throw new Error(
									"This file changed on disk. Read the current version before saving again."
								);
							}
							if (!io.writeBinary) {
								throw new Error("Binary writes unavailable");
							}
							await io.writeBinary(path, blob);
							return await read();
						});
					}
				: undefined,
	};
}
