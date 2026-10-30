import { getShadowFrame } from "@/src/lib/api/shadow.ts";

/** Read a Blob as a `data:` URL (FileReader) so a binary result crosses the
 *  MessagePort as a string the CSP-locked frame can render. */
export function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.readAsDataURL(blob);
	});
}

/** Open the OS file dialog for a WAV audio file on behalf of the sandboxed meetings
 *  companion (its frame carries no picker + cannot POST multipart under the CSP, so
 *  the host owns the import — the timeline host-owns-the-privileged-op pattern). The
 *  `accept` filter mirrors the desktop page's hidden `<input>`. Resolves to the chosen
 *  `File`, or `null` if the user cancels the dialog. */
export function pickAudioFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "audio/wav,.wav";
		let settled = false;
		const onFocus = () => {
			// Fallback for webviews that never fire `cancel` (WKWebView on macOS, which
			// Tauri uses): when the window regains focus after the OS dialog closes, give
			// `change` a tick to arrive; if no file was chosen it was a cancel. Without
			// this the picker promise would hang and the frame's Import button would stay
			// stuck on "Importing…".
			window.setTimeout(() => {
				if (!input.files?.length) {
					done(null);
				}
			}, 300);
		};
		const done = (file: File | null) => {
			if (settled) {
				return;
			}
			settled = true;
			window.removeEventListener("focus", onFocus);
			input.remove();
			resolve(file);
		};
		input.addEventListener("change", () => done(input.files?.[0] ?? null));
		// Modern Chromium/Tauri webviews fire `cancel` when the dialog is dismissed.
		input.addEventListener("cancel", () => done(null));
		window.addEventListener("focus", onFocus);
		input.style.display = "none";
		document.body.appendChild(input);
		input.click();
	});
}

/** Open the OS file dialog for `ui.uploadFile`. Same cancel/focus fallback as
 *  {@link pickAudioFile}. Resolves to the chosen files, or `null` on cancel. */
export function pickFiles(opts?: {
	accept?: string;
	multiple?: boolean;
}): Promise<File[] | null> {
	return new Promise((resolve) => {
		const input = document.createElement("input");
		input.type = "file";
		if (opts?.accept) {
			input.accept = opts.accept;
		}
		input.multiple = opts?.multiple === true;
		let settled = false;
		const onFocus = () => {
			window.setTimeout(() => {
				if (!input.files?.length) {
					done(null);
				}
			}, 300);
		};
		const done = (files: File[] | null) => {
			if (settled) {
				return;
			}
			settled = true;
			window.removeEventListener("focus", onFocus);
			input.remove();
			resolve(files);
		};
		input.addEventListener("change", () => {
			const list = input.files ? Array.from(input.files) : [];
			done(list.length > 0 ? list : null);
		});
		input.addEventListener("cancel", () => done(null));
		window.addEventListener("focus", onFocus);
		input.style.display = "none";
		document.body.appendChild(input);
		input.click();
	});
}

/** Fetch the Shadow keyframe at `tsMicros` and return it as a `data:` URL (the
 *  timeline companion's frame, blocked from a direct `<img src>` by the frame CSP
 *  `img-src data: blob:`). The shell (unsandboxed) reaches device-local Shadow
 *  through the LOCAL Core's `/api/shadow` proxy (`getShadowFrame` — Shadow's own HTTP
 *  surface is bearer-gated and 403s browser requests; the `shadow.ts` INVARIANT
 *  still holds: never the per-tab node).
 *  Resolves to `null` when no keyframe exists near that moment (Shadow 404s), so the
 *  companion renders its "No frame recorded" placeholder — parity with the desktop
 *  page's `<img onError>` fallback. */
export async function fetchFrameDataUrl(
	tsMicros: number
): Promise<string | null> {
	try {
		const frame = await getShadowFrame(tsMicros);
		if (!frame) {
			return null;
		}
		return await blobToDataUrl(frame);
	} catch {
		return null;
	}
}

/** Normalize a media URL to a `data:` URL. Local results are already `data:`;
 *  remote provider URLs (Replicate/Fal) are fetched HOST-side (the trusted webview
 *  has network; the frame does not) and inlined so `img/media-src data: blob:` can
 *  render them. */
export async function inlineToDataUrl(url: string): Promise<string> {
	if (url.startsWith("data:")) {
		return url;
	}
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`failed to fetch media: ${resp.status}`);
	}
	return await blobToDataUrl(await resp.blob());
}
