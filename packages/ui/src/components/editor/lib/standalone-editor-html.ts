import {
	escapeExportHtml,
	exportDocumentLanguage,
	exportDocumentTitle,
	htmlLanguageAttributes,
	markBlocksDirectionAuto,
} from "./export-document-language.ts";

function localStyles(documentSource: Document): string {
	const origin = documentSource.location?.origin;
	const rules = (sheet: CSSStyleSheet): string => {
		if (
			sheet.href &&
			new URL(sheet.href, documentSource.baseURI).origin !== origin
		) {
			return "";
		}
		try {
			return Array.from(sheet.cssRules, ruleText).join("\n");
		} catch {
			return "";
		}
	};
	const ruleText = (rule: CSSRule): string => {
		if (rule.type === CSSRule.FONT_FACE_RULE) {
			return "";
		}
		if (rule instanceof CSSImportRule) {
			return rule.styleSheet ? rules(rule.styleSheet) : "";
		}
		if (
			!(rule instanceof CSSStyleRule) &&
			(rule instanceof CSSGroupingRule || rule instanceof CSSKeyframesRule)
		) {
			const header = rule.cssText.slice(0, rule.cssText.indexOf("{"));
			return `${header}{${Array.from(rule.cssRules, ruleText).join("\n")}}`;
		}
		return rule.cssText;
	};
	return Array.from(documentSource.styleSheets, rules).join("\n");
}

/** Each text block resolves its own direction from its content. */
function withBlockDirections(editorHtml: string, documentSource: Document) {
	const template = documentSource.createElement("template");
	template.innerHTML = editorHtml;
	markBlocksDirectionAuto(template.content);
	return template.innerHTML;
}

export interface StandaloneEditorHtmlOptions {
	/** The document's name, used as its `<title>`. */
	readonly title?: string;
}

/**
 * Export styles are copied from this app, never fetched from a font or CSS
 * CDN. The page declares the UI's language and direction, and each block
 * carries `dir="auto"`.
 */
export function buildStandaloneEditorHtml(
	editorHtml: string,
	documentSource: Document = document,
	options: StandaloneEditorHtmlOptions = {}
): string {
	const styles = localStyles(documentSource).replace(/<\/style/gi, "<\\/style");
	const language = htmlLanguageAttributes(exportDocumentLanguage());
	const title = escapeExportHtml(exportDocumentTitle(options.title));
	const body = withBlockDirections(editorHtml, documentSource);
	return `<!doctype html>
<html${language}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${styles}
:root{--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace;--font-heading:system-ui,sans-serif}
body{font-family:system-ui,sans-serif}pre,code{font-family:ui-monospace,monospace}
.katex-html{display:none!important}.katex-mathml{position:static!important;clip:auto!important;width:auto!important;height:auto!important;overflow:visible!important}
</style></head><body>${body}</body></html>`;
}
