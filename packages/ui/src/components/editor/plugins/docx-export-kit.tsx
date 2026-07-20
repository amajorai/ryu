import { DocxExportPlugin } from "@platejs/docx-io";
import { CalloutElementDocx } from "@ryu/ui/components/editor/ui/callout-node-static.tsx";
import {
	CodeBlockElementDocx,
	CodeLineElementDocx,
	CodeSyntaxLeafDocx,
} from "@ryu/ui/components/editor/ui/code-block-node-static.tsx";
import {
	ColumnElementDocx,
	ColumnGroupElementDocx,
} from "@ryu/ui/components/editor/ui/column-node-static.tsx";
import {
	EquationElementDocx,
	InlineEquationElementDocx,
} from "@ryu/ui/components/editor/ui/equation-node-static.tsx";
import { TocElementDocx } from "@ryu/ui/components/editor/ui/toc-node-static.tsx";
import { KEYS } from "platejs";

/**
 * Editor kit for DOCX export.
 *
 * Uses standard static components for most elements (with juice CSS inlining),
 * but uses docx-specific components for elements that need special handling:
 * - Code blocks (syntax highlighting, line breaks)
 * - Columns (table layout instead of flexbox)
 * - Equations (inline font instead of KaTeX)
 * - Callouts (table layout for icon placement)
 * - TOC (anchor links with paragraph breaks)
 *
 * Tables use base version with juice CSS inlining.
 */
export const DocxExportKit = [
	DocxExportPlugin.configure({
		override: {
			components: {
				[KEYS.codeBlock]: CodeBlockElementDocx,
				[KEYS.codeLine]: CodeLineElementDocx,
				[KEYS.codeSyntax]: CodeSyntaxLeafDocx,
				[KEYS.column]: ColumnElementDocx,
				[KEYS.columnGroup]: ColumnGroupElementDocx,
				[KEYS.equation]: EquationElementDocx,
				[KEYS.inlineEquation]: InlineEquationElementDocx,
				[KEYS.callout]: CalloutElementDocx,
				[KEYS.toc]: TocElementDocx,
			},
		},
	}),
];
