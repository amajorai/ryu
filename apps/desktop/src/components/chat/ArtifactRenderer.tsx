// apps/desktop/src/components/chat/ArtifactRenderer.tsx
//
// Draws a detected "rendered / canvas artifact" (see lib/artifacts.ts) in the
// right panel. HTML and SVG render inside a STRICT sandboxed iframe; mermaid is
// compiled to an SVG (lazily, off the main bundle) and rendered the same way;
// code is shown read-only.
//
// SECURITY POSTURE — modelled on PluginHostPanel / ExtensionHost (do not weaken):
//   - The frame is `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so it
//     runs at a NULL origin: no parent DOM, no cookies/storage, no Tauri IPC.
//   - A per-document CSP (`connect-src 'none'`, `default-src 'none'`) blocks all
//     network egress, so a poisoned artifact cannot beacon/exfiltrate or pull a
//     remote payload. Only inline script/style and data: media run.
//   - Rendering is fully guarded: a bad artifact shows an inline error, never
//     throws into the chat tree (the iframe isolates HTML/SVG faults; mermaid
//     compilation is try/caught).

import {
	AlertCircleIcon,
	BrowserIcon,
	Flowchart01Icon,
	Image02Icon,
	SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useState } from "react";
import type { Artifact, ArtifactKind } from "@/src/lib/artifacts.ts";

// One CSP for every sandboxed artifact document. `unsafe-eval` mirrors the plugin
// host (some HTML artifacts self-compile); `connect-src 'none'` still forbids any
// network so nothing can be fetched to eval or beaconed out.
const ARTIFACT_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;

const HEAD_OPEN_RE = /<head[^>]*>/i;
const HTML_OPEN_RE = /<html[^>]*>/i;

const BASE_STYLE =
	":root{color-scheme:light dark}html,body{margin:0}body{padding:12px;box-sizing:border-box;font:14px/1.5 system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}img,svg{max-width:100%;height:auto}svg{display:block;margin:0 auto}";

/** Wrap a body fragment (SVG source, mermaid SVG) in a minimal, CSP-locked doc. */
function wrapFragment(body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8">${CSP_META}<style>${BASE_STYLE}</style></head><body>${body}</body></html>`;
}

/** Inject the CSP meta as the first thing in <head> of a full HTML document. */
function injectCsp(html: string): string {
	const headMatch = HEAD_OPEN_RE.exec(html);
	if (headMatch) {
		const at = headMatch.index + headMatch[0].length;
		return html.slice(0, at) + CSP_META + html.slice(at);
	}
	const htmlMatch = HTML_OPEN_RE.exec(html);
	if (htmlMatch) {
		const at = htmlMatch.index + htmlMatch[0].length;
		return `${html.slice(0, at)}<head>${CSP_META}</head>${html.slice(at)}`;
	}
	return wrapFragment(html);
}

const FULL_DOC_RE = /<html[\s>]|<!doctype html/i;

/** The synchronous srcdoc for HTML/SVG artifacts (mermaid is compiled async). */
function syncDocFor(kind: ArtifactKind, content: string): string | null {
	if (kind === "html") {
		return FULL_DOC_RE.test(content)
			? injectCsp(content)
			: wrapFragment(content);
	}
	if (kind === "svg") {
		return wrapFragment(content);
	}
	return null;
}

const MERMAID_ID_UNSAFE_RE = /[^a-zA-Z0-9_-]/g;

/** Compile mermaid DSL → SVG string. Imported lazily so mermaid (large) stays
 *  off the main bundle and only loads when an artifact needs it. */
async function compileMermaid(id: string, code: string): Promise<string> {
	const mermaidModule = await import("mermaid");
	const mermaid = mermaidModule.default;
	const prefersDark =
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-color-scheme: dark)").matches;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		theme: prefersDark ? "dark" : "default",
	});
	const safeId = `artifact-mermaid-${id.replace(MERMAID_ID_UNSAFE_RE, "")}`;
	const { svg } = await mermaid.render(safeId, code);
	return svg;
}

const KIND_ICON: Record<ArtifactKind, IconSvgElement> = {
	html: BrowserIcon,
	svg: Image02Icon,
	mermaid: Flowchart01Icon,
	code: SourceCodeIcon,
};

const KIND_LABEL: Record<ArtifactKind, string> = {
	html: "HTML",
	svg: "SVG",
	mermaid: "Diagram",
	code: "Code",
};

function ArtifactFrame({ doc, title }: { doc: string; title: string }) {
	return (
		<iframe
			// allow-scripts WITHOUT allow-same-origin → null origin, no Tauri IPC,
			// no parent DOM. The doc's CSP blocks all network egress.
			className="h-full w-full border-0 bg-background"
			referrerPolicy="no-referrer"
			sandbox="allow-scripts"
			srcDoc={doc}
			title={title}
		/>
	);
}

function ArtifactError({ message }: { message: string }) {
	return (
		<div className="flex h-full items-center justify-center p-6">
			<div className="flex max-w-sm items-start gap-2 text-destructive text-xs">
				<HugeiconsIcon
					aria-hidden
					className="mt-0.5 size-4 shrink-0"
					icon={AlertCircleIcon}
				/>
				<span className="whitespace-pre-wrap break-words">{message}</span>
			</div>
		</div>
	);
}

function ArtifactBody({ artifact }: { artifact: Artifact }) {
	const [mermaidDoc, setMermaidDoc] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	// HTML/SVG documents are synchronous; recompute only when the source changes.
	const syncDoc = useMemo(
		() => syncDocFor(artifact.kind, artifact.content),
		[artifact.kind, artifact.content]
	);

	useEffect(() => {
		if (artifact.kind !== "mermaid") {
			return;
		}
		let cancelled = false;
		setMermaidDoc(null);
		setError(null);
		compileMermaid(artifact.id, artifact.content)
			.then((svg) => {
				if (!cancelled) {
					setMermaidDoc(wrapFragment(svg));
				}
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(
						err instanceof Error ? err.message : "Failed to render diagram"
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [artifact.id, artifact.kind, artifact.content]);

	if (artifact.kind === "code") {
		return (
			<div className="h-full overflow-auto bg-sidebar">
				<pre className="p-3 font-mono text-[12.5px] text-foreground leading-[1.55]">
					<code>{artifact.content}</code>
				</pre>
			</div>
		);
	}

	if (error) {
		return <ArtifactError message={error} />;
	}

	if (artifact.kind === "mermaid") {
		if (!mermaidDoc) {
			return (
				<div className="flex h-full animate-pulse items-center justify-center text-muted-foreground text-xs">
					Rendering diagram…
				</div>
			);
		}
		return <ArtifactFrame doc={mermaidDoc} title={artifact.title} />;
	}

	if (!syncDoc) {
		return <ArtifactError message="This artifact cannot be rendered." />;
	}
	return <ArtifactFrame doc={syncDoc} title={artifact.title} />;
}

export function ArtifactRenderer({ artifact }: { artifact: Artifact }) {
	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-border/60 border-b px-3 py-2">
				<HugeiconsIcon
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
					icon={KIND_ICON[artifact.kind]}
				/>
				<span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
					{artifact.title}
				</span>
				<span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
					{KIND_LABEL[artifact.kind]}
				</span>
			</div>
			{/* Keyed on id so switching artifacts remounts the frame/compile cleanly. */}
			<div className="min-h-0 flex-1 overflow-hidden" key={artifact.id}>
				<ArtifactBody artifact={artifact} />
			</div>
		</div>
	);
}
