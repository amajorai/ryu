import {
	ARTIFACT_PAGE_STATE_MAX_BYTES,
	ARTIFACT_PAGE_STATE_MAX_DEPTH,
} from "@ryu/blocks/desktop/agent-elements/agent-ui/state-limits.ts";
import type { ArtifactKind } from "./artifacts.ts";

// `unsafe-eval` supports self-compiling artifacts; the null-origin iframe and
// `connect-src 'none'` still prevent remote code or data exfiltration.
export const ARTIFACT_CSP =
	"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
const DOCTYPE_RE = /^\s*<!doctype[^>]*>/i;
const FULL_DOC_RE = /<html[\s>]|<!doctype html/i;
const BASE_STYLE =
	"html,body{margin:0}body{padding:12px;box-sizing:border-box;font:14px/1.5 var(--font-sans);background:var(--background);color:var(--foreground)}img,svg{max-width:100%;height:auto}svg{display:block;margin:0 auto}";

/** Message type the in-frame size reporter posts to the host window. */
export const ARTIFACT_SIZE_MESSAGE = "ryu-artifact-size";

// Reports the document's natural content height so the inline chat card can
// grow to fit, the way an image would. It only posts a number to the parent:
// the frame stays at a null origin and can't read anything back.
const SIZE_REPORTER = `<script>(()=>{let last=-1;const post=()=>{const b=document.body;if(!b)return;const s=getComputedStyle(b);const h=Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+parseFloat(s.marginTop||"0")+parseFloat(s.marginBottom||"0"));if(Math.abs(h-last)<2)return;last=h;parent.postMessage({type:"${ARTIFACT_SIZE_MESSAGE}",height:h},"*")};const start=()=>{post();new ResizeObserver(post).observe(document.body);addEventListener("load",post)};document.body?start():addEventListener("DOMContentLoaded",start)})()</script>`;

/** Message type the in-frame `ryu.state.set` posts to the host window. */
export const ARTIFACT_STATE_MESSAGE = "ryu-artifact-state";
/** Largest state object a page may save, in UTF-8 bytes of its JSON. Core caps
 *  the whole saved record at 64 KiB; the rest is room for the host's wrapper. */
export const ARTIFACT_STATE_MAX_BYTES = ARTIFACT_PAGE_STATE_MAX_BYTES;
/** Deepest nesting a page's state object may use (the object is level 0). */
export const ARTIFACT_STATE_MAX_DEPTH = ARTIFACT_PAGE_STATE_MAX_DEPTH;

/** Saved page state handed back to the page through `ryu.state.get()`. */
export type ArtifactSavedState = Record<string, unknown>;

// Characters that would let embedded JSON end the <script> element or break
// the JS string it sits in. JSON.stringify leaves them literal.
const SCRIPT_UNSAFE_JSON_RE = /[<>&\u2028\u2029]/g;

function scriptSafeJson(value: ArtifactSavedState | null): string {
	return JSON.stringify(value).replace(
		SCRIPT_UNSAFE_JSON_RE,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
	);
}

// `window.ryu.state` lets a page keep state (a game score, a ticked list, form
// input) across reloads of the chat. `get()` returns the saved object embedded
// at load; `set(obj)` posts a plain-object snapshot to the host, which saves it.
// `set` measures what Core will measure (UTF-8 bytes and nesting depth, see
// state-limits.ts) and throws a RangeError for state Core would refuse, so the
// page learns about it instead of the save failing silently.
// The frame still cannot read anything from the host.
function stateApi(saved: ArtifactSavedState | null): string {
	return `<script>(()=>{let saved=${scriptSafeJson(saved)};const copy=(v)=>v==null?null:JSON.parse(JSON.stringify(v));const deep=(v,d)=>{if(d>${ARTIFACT_STATE_MAX_DEPTH})return true;if(v!==null&&typeof v==="object"){for(const k in v){if(deep(v[k],d+1))return true}}return false};window.ryu={state:{get:()=>copy(saved),set:(next)=>{if(next===null||typeof next!=="object"||Array.isArray(next))throw new TypeError("ryu.state.set expects a plain object");const text=JSON.stringify(next);if(new TextEncoder().encode(text).length>${ARTIFACT_STATE_MAX_BYTES})throw new RangeError("ryu.state is limited to ${ARTIFACT_STATE_MAX_BYTES} bytes of JSON");const parsed=JSON.parse(text);if(deep(parsed,0))throw new RangeError("ryu.state is limited to ${ARTIFACT_STATE_MAX_DEPTH} levels of nesting");saved=parsed;parent.postMessage({type:"${ARTIFACT_STATE_MESSAGE}",state:copy(saved)},"*")}}}})()</script>`;
}

/**
 * The app's design tokens, mirrored into the sandbox so agent-written pages,
 * charts and mocks can use `var(--primary)` etc. and look like Ryu rather
 * than a bare browser page. Names match the app's own CSS custom properties.
 */
export const ARTIFACT_THEME_TOKENS = [
	"--background",
	"--foreground",
	"--card",
	"--card-foreground",
	"--popover",
	"--popover-foreground",
	"--primary",
	"--primary-foreground",
	"--secondary",
	"--secondary-foreground",
	"--muted",
	"--muted-foreground",
	"--accent",
	"--accent-foreground",
	"--destructive",
	"--border",
	"--input",
	"--ring",
	"--radius",
	"--chart-1",
	"--chart-2",
	"--chart-3",
	"--chart-4",
	"--chart-5",
	"--font-sans",
	"--font-mono",
] as const;

type ArtifactThemeToken = (typeof ARTIFACT_THEME_TOKENS)[number];

export interface ArtifactTheme {
	dark: boolean;
	tokens: Partial<Record<ArtifactThemeToken, string>>;
}

// Used when no live theme is supplied (tests, non-DOM callers). Neutral values
// close to the app's defaults so a page written against the tokens still reads.
const FALLBACK_THEME: ArtifactTheme = {
	dark: false,
	tokens: {
		"--background": "Canvas",
		"--foreground": "CanvasText",
		"--card": "Canvas",
		"--card-foreground": "CanvasText",
		"--popover": "Canvas",
		"--popover-foreground": "CanvasText",
		"--primary": "#171717",
		"--primary-foreground": "#fafafa",
		"--secondary": "#f5f5f5",
		"--secondary-foreground": "#171717",
		"--muted": "#f5f5f5",
		"--muted-foreground": "#737373",
		"--accent": "#f5f5f5",
		"--accent-foreground": "#171717",
		"--destructive": "#dc2626",
		"--border": "#e5e5e5",
		"--input": "#e5e5e5",
		"--ring": "#a3a3a3",
		"--radius": "0.625rem",
		"--chart-1": "#2563eb",
		"--chart-2": "#16a34a",
		"--chart-3": "#f59e0b",
		"--chart-4": "#db2777",
		"--chart-5": "#7c3aed",
		"--font-sans": "system-ui, -apple-system, sans-serif",
		"--font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
	},
};

// Token values come from the app's own stylesheet, but they are spliced into a
// <style> element, so refuse anything that could close the rule or the tag.
const UNSAFE_TOKEN_VALUE_RE = /[<>{};\\]/;

function themeStyle(theme: ArtifactTheme): string {
	const declarations: string[] = [
		`color-scheme:${theme.dark ? "dark" : "light"}`,
	];
	for (const name of ARTIFACT_THEME_TOKENS) {
		const supplied = theme.tokens[name]?.trim();
		const value =
			supplied && !UNSAFE_TOKEN_VALUE_RE.test(supplied)
				? supplied
				: FALLBACK_THEME.tokens[name];
		if (value) {
			declarations.push(`${name}:${value}`);
		}
	}
	return `<style>:root{${declarations.join(";")}}</style>`;
}

interface SrcDocExtras {
	savedState: ArtifactSavedState | null;
	theme: ArtifactTheme;
}

function headExtras({ savedState, theme }: SrcDocExtras): string {
	return `<meta charset="utf-8">${CSP_META}${themeStyle(theme)}${SIZE_REPORTER}${stateApi(savedState)}`;
}

function wrapFragment(body: string, extras: SrcDocExtras): string {
	return `<!doctype html><html${extras.theme.dark ? ' class="dark"' : ""}><head>${headExtras(extras)}<style>${BASE_STYLE}</style></head><body>${body}</body></html>`;
}

/** Prefix the policy before parsing any model-controlled HTML token. Full
 *  documents keep their own styling; they only receive the token variables. */
function lockFullDocument(html: string, extras: SrcDocExtras): string {
	const content = html.replace(DOCTYPE_RE, "");
	return `<!doctype html>${headExtras(extras)}${content}`;
}

/** Build the synchronous srcdoc for HTML/SVG artifacts. */
export function artifactSrcDoc(
	kind: ArtifactKind,
	content: string,
	theme: ArtifactTheme = FALLBACK_THEME,
	savedState: ArtifactSavedState | null = null
): string | null {
	const extras: SrcDocExtras = { savedState, theme };
	if (kind === "html") {
		return FULL_DOC_RE.test(content)
			? lockFullDocument(content, extras)
			: wrapFragment(content, extras);
	}
	if (kind === "svg") {
		return wrapFragment(content, extras);
	}
	return null;
}
