// The two halves of a file card download: turning an inline URL into bytes,
// and handing bytes to the browser as a download.
//
// The page never writes a file and never names a folder. It gives the browser
// a Blob and a bare file name (`safeDownloadName`); the browser or the desktop
// web view saves it to the downloads folder or asks the user where to put it.
// The Blob it gives is always typed `application/octet-stream`, and only a
// `data:` or `blob:` URL is ever turned into bytes.

import { baseMime, safeDownloadName } from "./file-card-logic.ts";

/** How long the object URL stays alive after the click. Some web views read it late. */
const REVOKE_DELAY_MS = 30_000;

const DATA_URL = /^data:([^,;]*)((?:;[^,;]*)*),/u;

/**
 * Bytes of a `data:` URL, decoded here and not through `fetch`, so a strict
 * connect policy cannot block it. `null` when the URL is not a data URL or its
 * payload does not decode.
 */
export function blobFromDataUrl(url: string): Blob | null {
	const match = DATA_URL.exec(url);
	if (!match) {
		return null;
	}
	const type = baseMime(match[1]) || "application/octet-stream";
	const payload = url.slice(match[0].length);
	try {
		if (!match[2]?.endsWith(";base64")) {
			return new Blob([decodeURIComponent(payload)], { type });
		}
		const binary = atob(payload);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return new Blob([bytes], { type });
	} catch {
		return null;
	}
}

/**
 * True for the two kinds of URL whose bytes are already on this device, a
 * `data:` URL carried in the message and a `blob:` URL the page made. Core
 * sends an assistant file part as a data URL and no agent runtime sends one
 * with a web address, so the card reads nothing from the network.
 */
export function isInlineFileUrl(url: string): boolean {
	return url.startsWith("data:") || url.startsWith("blob:");
}

/**
 * Bytes behind the URL of an assistant file part. A data URL is decoded in
 * place and a blob URL is read from the page's own store. Any other URL (a
 * web address, a path on the node) is refused without a request, so a click
 * on Download never fetches an address the agent chose. `null` on failure.
 */
export async function blobFromFileUrl(
	url: string,
	fetcher: typeof fetch = fetch
): Promise<Blob | null> {
	if (url.startsWith("data:")) {
		return blobFromDataUrl(url);
	}
	if (!url.startsWith("blob:")) {
		return null;
	}
	try {
		const response = await fetcher(url, { credentials: "omit" });
		return response.ok ? await response.blob() : null;
	} catch {
		return null;
	}
}

/** The seams `saveBlobAs` needs from the page; tests pass their own. */
export interface SaveBlobEnvironment {
	createObjectURL: (blob: Blob) => string;
	document: Document;
	revokeObjectURL: (url: string) => void;
	schedule: (run: () => void, delayMs: number) => void;
}

function pageEnvironment(): SaveBlobEnvironment {
	return {
		createObjectURL: (blob) => URL.createObjectURL(blob),
		document: globalThis.document,
		revokeObjectURL: (url) => URL.revokeObjectURL(url),
		schedule: (run, delayMs) => {
			setTimeout(run, delayMs);
		},
	};
}

/** The type every download is handed to the browser with. */
const NEUTRAL_TYPE = "application/octet-stream";

/**
 * Start a browser download of `blob`. Returns the file name that was
 * suggested, which is always a bare name and never a path.
 *
 * The agent chooses the type of the bytes. The name still follows that type,
 * but the object URL is made from a copy typed `application/octet-stream`. A
 * web view that navigates to the URL instead of saving it then gets bytes it
 * cannot draw, so an agent's HTML never opens as a page in the app's origin.
 */
export function saveBlobAs(
	blob: Blob,
	name: string | null | undefined,
	environment: SaveBlobEnvironment = pageEnvironment()
): string {
	const fileName = safeDownloadName(name, blob.type);
	const url = environment.createObjectURL(
		blob.slice(0, blob.size, NEUTRAL_TYPE)
	);
	const link = environment.document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.rel = "noopener";
	link.hidden = true;
	environment.document.body.append(link);
	link.click();
	link.remove();
	environment.schedule(() => environment.revokeObjectURL(url), REVOKE_DELAY_MS);
	return fileName;
}
