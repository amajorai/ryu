import { Globe02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

export const URL_PROTOCOL_RE = /^https?:\/\//i;

// ── Iframe panel (browser tab) ────────────────────────────────────────────────

// Block Tauri's own origins so iframe scripts can never reach __TAURI__ APIs.
const BLOCKED_URL_RE = /^(tauri:|asset:|[a-z]+:\/\/tauri\.localhost)/i;

export function IframePanel({
	initialUrl,
	title,
}: {
	initialUrl: string;
	title: string;
}) {
	const [src, setSrc] = useState(initialUrl);
	const [inputVal, setInputVal] = useState(initialUrl);
	// A sandboxed cross-origin iframe is opaque: `onLoad` fires on success (and on
	// about:blank), but there is no reliable `onError` for X-Frame-Options /
	// navigation failures. So we can only show progress, not a hard failure —
	// clear the spinner on `onLoad`, and after a few seconds surface a hint that
	// heavy pages (some sites ship multi-MB documents) are still downloading, so a
	// blank pane doesn't read as a hang.
	const [loading, setLoading] = useState(true);
	const [slow, setSlow] = useState(false);

	useEffect(() => {
		setSrc(initialUrl);
		setInputVal(initialUrl);
	}, [initialUrl]);

	useEffect(() => {
		setLoading(true);
		setSlow(false);
		const t = setTimeout(() => setSlow(true), 4000);
		return () => clearTimeout(t);
	}, [src]);

	const navigate = (raw: string) => {
		let url = raw.trim();
		if (!url || BLOCKED_URL_RE.test(url)) {
			return;
		}
		if (!URL_PROTOCOL_RE.test(url)) {
			url = `https://${url}`;
		}
		if (BLOCKED_URL_RE.test(url)) {
			return;
		}
		try {
			const protocol = new URL(url).protocol;
			if (protocol !== "http:" && protocol !== "https:") {
				return;
			}
		} catch {
			return;
		}
		setSrc(url);
		setInputVal(url);
	};

	return (
		<div className="flex h-full flex-col">
			{/* Plain shrink-0 bar — NOT SidebarContent, whose base `flex-1` grows to
			    eat half the panel and shove the iframe into the bottom half. */}
			<div className="flex h-10 shrink-0 flex-col justify-center border-border border-b px-2">
				<form
					className="flex items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						navigate(inputVal);
					}}
				>
					<HugeiconsIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						icon={Globe02Icon}
					/>
					<input
						aria-label="Address"
						className="min-w-0 flex-1 rounded-lg bg-background px-2 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
						onChange={(e) => setInputVal(e.target.value)}
						placeholder="Enter URL…"
						spellCheck={false}
						value={inputVal}
					/>
				</form>
			</div>
			<div className="relative min-h-0 w-full flex-1">
				<iframe
					className="absolute inset-0 h-full w-full border-0 bg-white"
					key={src}
					onLoad={() => setLoading(false)}
					sandbox="allow-scripts allow-forms allow-popups"
					src={src}
					title={title}
				/>
				{loading && (
					<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 text-muted-foreground text-xs">
						<HugeiconsIcon className="size-4 animate-spin" icon={RefreshIcon} />
						<span>{slow ? "Still loading — large page…" : "Loading…"}</span>
					</div>
				)}
			</div>
		</div>
	);
}
