"use client";

// beui.dev/components/agents/agent-code

import { cn } from "@ryu/ui/lib/utils.ts";
import { type CSSProperties, Fragment, useEffect, useState } from "react";
import type { Highlighter } from "shiki";

/**
 * Languages the agent code surfaces highlight — a command, a diff, a JSON
 * payload, a source excerpt. Anything else normalises to `text` rather than
 * throwing.
 *
 * The grammars are NOT loaded from this list. Each one is a separate async
 * chunk, and a thread whose first tool row is a one-line `ls` should not wait
 * on nine of them; `useAgentCodeTokens` loads exactly the grammar it is about
 * to use, once, and shiki caches it from there.
 */
export const AGENT_CODE_LANGUAGES = [
	"bash",
	"diff",
	"json",
	"text",
	"tsx",
	"typescript",
	"javascript",
	"python",
	"rust",
	"yaml",
] as const;

export type AgentCodeLanguage = (typeof AGENT_CODE_LANGUAGES)[number];

const LANGUAGE_MAP = new Map<string, AgentCodeLanguage>(
	AGENT_CODE_LANGUAGES.map((language) => [language, language])
);

/** Normalise a free-form language hint (a markdown fence, an ACP tool kind). */
export function toAgentCodeLanguage(hint?: string | null): AgentCodeLanguage {
	if (!hint) {
		return "text";
	}
	const lower = hint.toLowerCase();
	const aliased = AGENT_CODE_LANGUAGE_ALIASES.get(lower) ?? lower;
	return LANGUAGE_MAP.get(aliased) ?? "text";
}

const AGENT_CODE_LANGUAGE_ALIASES = new Map(
	Object.entries({
		sh: "bash",
		shell: "bash",
		zsh: "bash",
		console: "bash",
		js: "javascript",
		jsx: "tsx",
		mjs: "javascript",
		cjs: "javascript",
		ts: "typescript",
		py: "python",
		rs: "rust",
		yml: "yaml",
		patch: "diff",
	})
);

export interface AgentCodeToken {
	content: string;
	dark?: string;
	light?: string;
	offset: number;
}

export type AgentCodeTokenLines = AgentCodeToken[][];

export interface AgentCodeProps {
	className?: string;
	code: string;
	language?: AgentCodeLanguage;
}

export interface AgentCodeLineProps {
	className?: string;
	code: string;
	tokens?: AgentCodeToken[];
}

const LIGHT_THEME = "github-light-high-contrast";
const DARK_THEME = "github-dark-high-contrast";
let agentCodeHighlighter: Promise<Highlighter> | null = null;
const tokenCache = new Map<string, AgentCodeTokenLines>();

function getAgentCodeHighlighter() {
	if (!agentCodeHighlighter) {
		// Shiki (and its regex engine) loads with the first block it highlights,
		// not with the routes that merely can show one.
		agentCodeHighlighter = import("shiki").then(({ createHighlighter }) =>
			createHighlighter({
				themes: [LIGHT_THEME, DARK_THEME],
				langs: [],
			})
		);
	}
	return agentCodeHighlighter;
}

/** Resolve the highlighter with `language`'s grammar loaded, and only that one. */
async function getHighlighterFor(language: AgentCodeLanguage) {
	const highlighter = await getAgentCodeHighlighter();
	// `text` is shiki's built-in no-op grammar — asking to load it throws.
	if (
		language !== "text" &&
		!highlighter.getLoadedLanguages().includes(language)
	) {
		await highlighter.loadLanguage(language);
	}
	return highlighter;
}

function tokenCacheKey(code: string, language: AgentCodeLanguage) {
	return `${language}\u0000${code}`;
}

/**
 * Tokenise `code` for both themes at once, so a theme flip is a CSS variable
 * swap rather than a re-highlight.
 *
 * The return is deliberately optimistic while a turn streams: until the fresh
 * tokens land, the previous result is reused whenever the new code merely
 * EXTENDS it. Highlighting the same growing string from scratch on every chunk
 * would otherwise flash the whole block back to plain text between frames.
 */
export function useAgentCodeTokens(code: string, language: AgentCodeLanguage) {
	const key = tokenCacheKey(code, language);
	const cached = tokenCache.get(key);
	const [result, setResult] = useState<{
		code: string;
		key: string;
		language: AgentCodeLanguage;
		lines: AgentCodeTokenLines;
	} | null>(cached ? { key, code, language, lines: cached } : null);

	useEffect(() => {
		const current = tokenCache.get(key);
		if (current) {
			setResult({ key, code, language, lines: current });
			return;
		}

		let cancelled = false;
		getHighlighterFor(language)
			.then((highlighter) => {
				if (cancelled) {
					return;
				}
				const lines = highlighter
					.codeToTokensWithThemes(code, {
						lang: language,
						themes: { light: LIGHT_THEME, dark: DARK_THEME },
					})
					.map((line) =>
						line.map((token) => ({
							content: token.content,
							offset: token.offset,
							light: token.variants.light?.color,
							dark: token.variants.dark?.color,
						}))
					);
				tokenCache.set(key, lines);
				setResult({ key, code, language, lines });
			})
			.catch(() => {
				// Highlighting is decorative — an unknown grammar or a failed
				// grammar fetch leaves the block as plain monospace text.
			});
		return () => {
			cancelled = true;
		};
	}, [code, key, language]);

	if (result?.key === key) {
		return result.lines;
	}
	if (result?.language === language && code.startsWith(result.code)) {
		return result.lines;
	}
	return null;
}

export function AgentCodeLine({ code, tokens, className }: AgentCodeLineProps) {
	if (!tokens) {
		return <span className={className}>{code}</span>;
	}
	return (
		<span className={className}>
			{tokens.map((token) => (
				<span
					className="text-[var(--agent-code-light)] dark:text-[var(--agent-code-dark)]"
					key={`${token.offset}-${token.content}`}
					style={
						// SAFETY: AgentCodeToken declares both palette slots as optional strings, and these nullish fallbacks are strings. React forwards these exact authored CSS custom-property cells with native style.setProperty; CSSProperties omits their keys. No color syntax validation is claimed.
						{
							"--agent-code-light": token.light ?? "currentColor",
							"--agent-code-dark": token.dark ?? token.light ?? "currentColor",
						} as CSSProperties
					}
				>
					{token.content}
				</span>
			))}
		</span>
	);
}

export function AgentCode({
	code,
	language = "bash",
	className,
}: AgentCodeProps) {
	const tokens = useAgentCodeTokens(code, language);
	let offset = 0;
	const lines = code.split("\n").map((content) => {
		const line = { content, offset };
		offset += content.length + 1;
		return line;
	});

	return (
		<pre
			className={cn(
				"m-0 overflow-x-auto whitespace-pre font-mono text-foreground/85 text-xs leading-5",
				className
			)}
		>
			<code>
				{lines.map((line, index) => (
					<Fragment key={line.offset}>
						<AgentCodeLine code={line.content} tokens={tokens?.[index]} />
						{index < lines.length - 1 ? "\n" : null}
					</Fragment>
				))}
			</code>
		</pre>
	);
}
