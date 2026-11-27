// apps/desktop/src/lib/artifact-files.ts
//
// Pure rules for artifacts that are files: which created artifacts draw as a
// file card, which stored Space file a payload names, and under which name an
// artifact's content is saved by Download.
//
// The payload comes from the agent's tool call, so nothing here trusts it. A
// stored file is addressed only by ids that look like ids, and a download name
// is only ever a name (the file card reduces it to a bare name again before it
// reaches the browser).

import {
	baseMime,
	fileExtension,
} from "@ryu/blocks/desktop/agent-elements/file-card-logic.ts";
import type { NativeArtifactObservation } from "@ryu/blocks/desktop/agent-elements/native-artifact-observation.ts";
import { nativeSdkSchemaAdmits } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-admission.ts";
import type { NativeSdkValue } from "@ryu/blocks/desktop/agent-elements/utils/native-sdk-observation.ts";
import { z } from "zod";
import { type ArtifactKind, artifactKindFromMime } from "./artifacts.ts";

const textSchema = z.string();
const sizeSchema = z.number();

/** A payload slot as text; `undefined` for anything that is not a non-empty string. */
export function artifactText(value: NativeSdkValue): string | undefined {
	return nativeSdkSchemaAdmits(textSchema, value) && value ? value : undefined;
}

/** A payload slot as a byte count; `undefined` for anything else. */
export function artifactByteSize(value: NativeSdkValue): number | undefined {
	return nativeSdkSchemaAdmits(sizeSchema, value) && value >= 0
		? value
		: undefined;
}

/** What Core mints for a Space and for a document (a UUID today). */
const STORED_ID = /^[A-Za-z0-9_-]{1,128}$/u;
/** The one route a created file's bytes are read from. */
const BLOB_ROUTE =
	/^\/api\/spaces\/([A-Za-z0-9_-]{1,128})\/documents\/([A-Za-z0-9_-]{1,128})\/blob$/u;

export interface SpaceFileRef {
	docId: string;
	spaceId: string;
}

/**
 * The stored Space file a created artifact names, or `null`. The ids come from
 * the tool result, else from a URL that is exactly the blob route. Any other
 * URL is ignored, so the node credentials are never sent to an address the
 * agent chose.
 */
export function spaceFileRef(
	payload: NativeArtifactObservation | null | undefined
): SpaceFileRef | null {
	const spaceId = artifactText(payload?.spaceId);
	const docId = artifactText(payload?.docId);
	if (spaceId || docId) {
		return spaceId && docId && STORED_ID.test(spaceId) && STORED_ID.test(docId)
			? { docId, spaceId }
			: null;
	}
	const match = BLOB_ROUTE.exec(artifactText(payload?.url) ?? "");
	return match?.[1] && match[2] ? { docId: match[2], spaceId: match[1] } : null;
}

/**
 * True when a created artifact is a stored file the chat cannot draw as text:
 * a PDF, an image, an office file, an archive. Those draw as a file card. A
 * created HTML page, SVG, table, markdown or code file keeps the artifact card.
 */
export function isFileCardArtifact(
	payload: NativeArtifactObservation | null | undefined
): boolean {
	if (artifactText(payload?.content) || !artifactText(payload?.url)) {
		return false;
	}
	const declared = artifactText(payload?.kind)?.toLowerCase();
	if (declared && declared !== "file") {
		return false;
	}
	return artifactKindFromMime(artifactText(payload?.mime)) === "file";
}

const KIND_EXTENSION: Record<ArtifactKind, string> = {
	code: "txt",
	database: "csv",
	file: "",
	html: "html",
	mermaid: "mmd",
	space: "md",
	svg: "svg",
};

// A Map, so a language named like an object member ("constructor") finds nothing.
const LANGUAGE_EXTENSION = new Map<string, string>([
	["bash", "sh"],
	["c", "c"],
	["cpp", "cpp"],
	["csharp", "cs"],
	["css", "css"],
	["go", "go"],
	["html", "html"],
	["java", "java"],
	["javascript", "js"],
	["js", "js"],
	["json", "json"],
	["jsx", "jsx"],
	["kotlin", "kt"],
	["markdown", "md"],
	["md", "md"],
	["php", "php"],
	["py", "py"],
	["python", "py"],
	["rb", "rb"],
	["rs", "rs"],
	["ruby", "rb"],
	["rust", "rs"],
	["sh", "sh"],
	["shell", "sh"],
	["sql", "sql"],
	["swift", "swift"],
	["toml", "toml"],
	["ts", "ts"],
	["tsx", "tsx"],
	["typescript", "ts"],
	["xml", "xml"],
	["yaml", "yaml"],
	["yml", "yml"],
]);

/** Endings that already say what a text file is, so none is added. */
const TEXT_FILE_EXTENSIONS = new Set([
	...LANGUAGE_EXTENSION.values(),
	...Object.values(KIND_EXTENSION).filter(Boolean),
	"htm",
	"log",
	"tsv",
	"txt",
]);

const JSON_START = /^\s*[[{]/u;

/** The slice of an artifact that Download needs. */
export interface DownloadableArtifact {
	content: string;
	kind: ArtifactKind;
	language?: NativeSdkValue;
	mime?: NativeSdkValue;
	title: string;
}

function contentExtension(artifact: DownloadableArtifact): string {
	if (artifact.kind === "code") {
		const language = artifactText(artifact.language)?.trim().toLowerCase();
		return LANGUAGE_EXTENSION.get(language ?? "") ?? KIND_EXTENSION.code;
	}
	if (artifact.kind === "database") {
		const json =
			baseMime(artifactText(artifact.mime)).includes("json") ||
			JSON_START.test(artifact.content);
		return json ? "json" : KIND_EXTENSION.database;
	}
	return KIND_EXTENSION[artifact.kind];
}

/**
 * The name Download suggests for an artifact: its title, with the ending its
 * kind is saved with when the title does not carry a text file ending already
 * ("Q3 chart" becomes "Q3 chart.html", "main.rs" stays).
 */
export function artifactDownloadName(artifact: DownloadableArtifact): string {
	const name = artifact.title.trim() || "artifact";
	if (TEXT_FILE_EXTENSIONS.has(fileExtension(name))) {
		return name;
	}
	const extension = contentExtension(artifact);
	return extension ? `${name}.${extension}` : name;
}

/**
 * An artifact's content as bytes for Download. Always plain text, whatever the
 * kind: the object URL made from it can then never open as a page.
 */
export function artifactContentBlob(content: string): Blob {
	return new Blob([content], { type: "text/plain;charset=utf-8" });
}
