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

/** Export styles are copied from this app, never fetched from a font or CSS CDN. */
export function buildStandaloneEditorHtml(
	editorHtml: string,
	documentSource: Document = document
): string {
	const styles = localStyles(documentSource).replace(/<\/style/gi, "<\\/style");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ryu document</title>
<style>${styles}
:root{--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace;--font-heading:system-ui,sans-serif}
body{font-family:system-ui,sans-serif}pre,code{font-family:ui-monospace,monospace}
.katex-html{display:none!important}.katex-mathml{position:static!important;clip:auto!important;width:auto!important;height:auto!important;overflow:visible!important}
</style></head><body>${editorHtml}</body></html>`;
}
