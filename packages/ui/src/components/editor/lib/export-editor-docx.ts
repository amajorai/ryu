import {
	DEFAULT_DOCX_MARGINS,
	DOCX_EXPORT_STYLES,
	htmlToDocxBlob,
} from "@platejs/docx-io";
import juice from "juice";
import { createSlateEditor, type Value } from "platejs";
import { serializeHtml } from "platejs/static";
import docxStyles from "../docx-nodes.css?raw";
import { BaseEditorKit } from "../editor-base-kit.tsx";
import {
	DocxExportComponents,
	DocxExportKit,
} from "../plugins/docx-export-kit.tsx";

const CUSTOM_PROPERTY = /var\((--[\w-]+)(?:,\s*([^)]*))?\)/g;
const FONT_FAMILY_DECLARATION = /(font-family\s*:\s*)([^;]*)/g;
const QUOTED_FONT_NAME = /"([^"]*)"/g;

/** Word's HTML importer needs concrete declarations, not CSS variable references. */
function resolveDocxVariables(html: string): string {
	const document = new DOMParser().parseFromString(html, "text/html");
	for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
		for (const property of Array.from(element.style)) {
			const value = element.style.getPropertyValue(property);
			const resolved = value.replace(
				CUSTOM_PROPERTY,
				(reference, name: string, fallback?: string) => {
					let owner: HTMLElement | null = element;
					while (owner) {
						const customValue = owner.style.getPropertyValue(name);
						if (customValue) {
							return customValue;
						}
						owner = owner.parentElement;
					}
					return fallback ?? reference;
				}
			);
			if (!property.startsWith("--") && resolved.includes("var(")) {
				// An unset custom property invalidates this declaration in CSS; omit it for Word too.
				element.style.removeProperty(property);
			} else if (resolved !== value) {
				element.style.setProperty(property, resolved);
			}
		}
		// The Word importer reads &quot; literally in font names. Equivalent single
		// quoted CSS names survive HTML attribute serialization without entities.
		const style = element.getAttribute("style");
		if (style) {
			element.setAttribute(
				"style",
				style.replace(
					FONT_FAMILY_DECLARATION,
					(_declaration, prefix: string, families: string) =>
						prefix +
						families.replace(
							QUOTED_FONT_NAME,
							(_name, family: string) => `'${family.replaceAll("'", "\\'")}'`
						)
				)
			);
		}
	}
	return document.documentElement.outerHTML;
}

/** Shared by the editor toolbar and the desktop file editor. */
export async function serializeEditorDocxHtml(value: Value): Promise<string> {
	const editor = createSlateEditor({
		plugins: [...BaseEditorKit, ...DocxExportKit],
		value,
	});
	// Match Plate DOCX export: plugin overrides select the Word-specific renderers.
	editor.meta.components = {
		...editor.meta.components,
		...DocxExportComponents,
	};
	const body = await serializeHtml(editor);
	const html = `<html lang="en"><head><meta charset="utf-8"><style>${DOCX_EXPORT_STYLES}\n${docxStyles}</style></head><body>${body}</body></html>`;
	return resolveDocxVariables(
		juice(html, {
			removeStyleTags: false,
			preserveMediaQueries: false,
			preserveFontFaces: false,
		})
	);
}

export async function exportEditorDocx(value: Value): Promise<Blob> {
	return htmlToDocxBlob(await serializeEditorDocxHtml(value), {
		margins: DEFAULT_DOCX_MARGINS,
		orientation: "portrait",
	});
}
