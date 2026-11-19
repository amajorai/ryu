import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import type { TCodeBlockElement, TCodeSyntaxLeaf } from "platejs";
import {
	SlateElement,
	type SlateElementProps,
	SlateLeaf,
	type SlateLeafProps,
} from "platejs/static";
import {
	codeBlockLanguageText,
	getCodeBlockLanguageLabel,
} from "./code-block-languages.tsx";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editorcodeBlockNodeStatic3-color"?: string | number;
	"--editorcodeBlockNodeStatic3-font-style"?: string | number;
	"--editorcodeBlockNodeStatic3-font-weight"?: string | number;
}

type CodeBlockElementStaticProps = SlateElementProps<TCodeBlockElement> & {
	showLanguageLabel?: boolean;
};

export function CodeBlockElementStatic({
	showLanguageLabel = true,
	...props
}: CodeBlockElementStaticProps) {
	const lang = props.element.lang;
	const languageLabel = getCodeBlockLanguageLabel(lang);

	return (
		<SlateElement
			className="py-1 **:[.hljs-addition]:bg-[#f0fff4] **:[.hljs-addition]:text-[#22863a] dark:**:[.hljs-addition]:bg-[#3c5743] dark:**:[.hljs-addition]:text-[#ceead5] **:[.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable]:text-[#005cc5] dark:**:[.hljs-attr,.hljs-attribute,.hljs-literal,.hljs-meta,.hljs-number,.hljs-operator,.hljs-selector-attr,.hljs-selector-class,.hljs-selector-id,.hljs-variable]:text-[#6596cf] **:[.hljs-built\\\\_in,.hljs-symbol]:text-[#e36209] dark:**:[.hljs-built\\\\_in,.hljs-symbol]:text-[#c3854e] **:[.hljs-bullet]:text-[#735c0f] **:[.hljs-comment,.hljs-code,.hljs-formula]:text-[#6a737d] dark:**:[.hljs-comment,.hljs-code,.hljs-formula]:text-[#6a737d] **:[.hljs-deletion]:bg-[#ffeef0] **:[.hljs-deletion]:text-[#b31d28] dark:**:[.hljs-deletion]:bg-[#473235] dark:**:[.hljs-deletion]:text-[#e7c7cb] **:[.hljs-emphasis]:italic **:[.hljs-keyword,.hljs-doctag,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language\\\\_]:text-[#d73a49] dark:**:[.hljs-keyword,.hljs-doctag,.hljs-template-tag,.hljs-template-variable,.hljs-type,.hljs-variable.language\\\\_]:text-[#ee6960] **:[.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo]:text-[#22863a] dark:**:[.hljs-name,.hljs-quote,.hljs-selector-tag,.hljs-selector-pseudo]:text-[#36a84f] **:[.hljs-regexp,.hljs-string,.hljs-meta_.hljs-string]:text-[#032f62] dark:**:[.hljs-regexp,.hljs-string,.hljs-meta_.hljs-string]:text-[#3593ff] **:[.hljs-section]:font-medium **:[.hljs-section]:text-[#005cc5] dark:**:[.hljs-section]:text-[#61a5f2] **:[.hljs-strong]:font-medium **:[.hljs-title,.hljs-title.class\\\\_,.hljs-title.class\\\\_.inherited\\\\_\\\\_,.hljs-title.function\\\\_]:text-[#6f42c1] dark:**:[.hljs-title,.hljs-title.class\\\\_,.hljs-title.class\\\\_.inherited\\\\_\\\\_,.hljs-title.function\\\\_]:text-[#a77bfa]"
			{...props}
		>
			<div className="relative rounded-md bg-muted/50">
				{showLanguageLabel && lang && languageLabel && (
					<div
						className="absolute end-1 top-1 z-10 flex h-6 select-none items-center px-2 text-muted-foreground text-xs"
						contentEditable={false}
					>
						{codeBlockLanguageText({ label: languageLabel, value: lang })}
					</div>
				)}

				<pre
					className="overflow-x-auto p-8 pe-4 text-start font-mono text-sm leading-[normal] [tab-size:2] print:break-inside-avoid"
					dir="ltr"
				>
					<code>{props.children}</code>
				</pre>
			</div>
		</SlateElement>
	);
}

export function CodeLineElementStatic(props: SlateElementProps) {
	return <SlateElement {...props} />;
}

export function CodeSyntaxLeafStatic(props: SlateLeafProps<TCodeSyntaxLeaf>) {
	const tokenClassName = props.leaf.className;

	return <SlateLeaf className={tokenClassName} {...props} />;
}

/**
 * DOCX-compatible code block components.
 * Uses export stylesheet rules and semantic tags for Word documents.
 */

export function CodeBlockElementDocx(
	props: SlateElementProps<TCodeBlockElement>
) {
	return (
		<SlateElement {...props}>
			<div data-docx-style="editorcodeBlockNodeStatic1">{props.children}</div>
		</SlateElement>
	);
}

export function CodeLineElementDocx(props: SlateElementProps) {
	return (
		<SlateElement
			{...props}
			as="p"
			attributes={{
				...props.attributes,
				"data-docx-style": "editorcodeBlockNodeStatic2",
			}}
		/>
	);
}

// Syntax highlighting color map for common token types
const syntaxColors = new Map(
	Object.entries({
		"hljs-addition": "#22863a",
		"hljs-attr": "#005cc5",
		"hljs-attribute": "#005cc5",
		"hljs-built_in": "#e36209",
		"hljs-bullet": "#735c0f",
		"hljs-comment": "#6a737d",
		"hljs-deletion": "#b31d28",
		"hljs-doctag": "#d73a49",
		"hljs-emphasis": "#24292e",
		"hljs-formula": "#6a737d",
		"hljs-keyword": "#d73a49",
		"hljs-literal": "#005cc5",
		"hljs-meta": "#005cc5",
		"hljs-name": "#22863a",
		"hljs-number": "#005cc5",
		"hljs-operator": "#005cc5",
		"hljs-quote": "#22863a",
		"hljs-regexp": "#032f62",
		"hljs-section": "#005cc5",
		"hljs-selector-attr": "#005cc5",
		"hljs-selector-class": "#005cc5",
		"hljs-selector-id": "#005cc5",
		"hljs-selector-pseudo": "#22863a",
		"hljs-selector-tag": "#22863a",
		"hljs-string": "#032f62",
		"hljs-strong": "#24292e",
		"hljs-symbol": "#e36209",
		"hljs-template-tag": "#d73a49",
		"hljs-template-variable": "#d73a49",
		"hljs-title": "#6f42c1",
		"hljs-type": "#d73a49",
		"hljs-variable": "#005cc5",
	})
);

// Convert regular spaces to non-breaking spaces to preserve indentation in Word
const preserveSpaces = (text: string): string => {
	// Replace regular spaces with non-breaking spaces
	return text.replace(/ /g, "\u00A0");
};

export function CodeSyntaxLeafDocx(props: SlateLeafProps<TCodeSyntaxLeaf>) {
	const tokenClassName = props.leaf.className;

	// Extract color from className
	let color: string | undefined;
	let fontWeight: string | undefined;
	let fontStyle: string | undefined;

	if (tokenClassName) {
		const classes = tokenClassName.split(" ");
		for (const cls of classes) {
			if (syntaxColors.get(cls)) {
				color = syntaxColors.get(cls);
			}
			if (cls === "hljs-strong" || cls === "hljs-section") {
				fontWeight = "500";
			}
			if (cls === "hljs-emphasis") {
				fontStyle = "italic";
			}
		}
	}

	// Get the text content and preserve spaces
	const text = props.leaf.text;
	const preservedText = preserveSpaces(text);

	const editorcodeBlockNodeStatic3Style: EditorVariableStyle = {
		"--editorcodeBlockNodeStatic3-color": color,
		"--editorcodeBlockNodeStatic3-font-style": fontStyle,
		"--editorcodeBlockNodeStatic3-font-weight": fontWeight,
	};
	return (
		<span
			data-docx-style="editorcodeBlockNodeStatic3"
			data-slate-leaf="true"
			style={editorcodeBlockNodeStatic3Style}
		>
			{fontWeight ? (
				<strong>{fontStyle ? <em>{preservedText}</em> : preservedText}</strong>
			) : fontStyle ? (
				<em>{preservedText}</em>
			) : (
				preservedText
			)}
		</span>
	);
}
