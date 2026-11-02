"use client";
import { useLiteralMessages } from "@ryu/i18n/react";
import { useMemo } from "react";
import type { StreamdownTranslations } from "streamdown";

// Streamdown's own controls (the code-block copy and download buttons, link
// safety, image and fullscreen chrome) default to English strings. They render
// inside the Markdown wrapper's `data-ryu-i18n="off"` subtree, which keeps the
// model's prose untouched, so the DOM localizer never reaches them: translate
// them here. Typing the object as the full `StreamdownTranslations` pins the
// keys, so a Streamdown upgrade that adds or renames one fails to typecheck.
// File-format names (SVG, PNG, MMD, CSV, TSV, Markdown) stay as written.
export function useStreamdownTranslations(): StreamdownTranslations {
	const tl = useLiteralMessages();
	return useMemo<StreamdownTranslations>(
		() => ({
			close: tl("Close"),
			copied: tl("Copied"),
			copyCode: tl("Copy code"),
			copyLink: tl("Copy link"),
			copyTable: tl("Copy table"),
			copyTableAsCsv: tl("Copy table as CSV"),
			copyTableAsMarkdown: tl("Copy table as Markdown"),
			copyTableAsTsv: tl("Copy table as TSV"),
			downloadDiagram: tl("Download diagram"),
			downloadDiagramAsMmd: tl("Download diagram as MMD"),
			downloadDiagramAsPng: tl("Download diagram as PNG"),
			downloadDiagramAsSvg: tl("Download diagram as SVG"),
			downloadFile: tl("Download file"),
			downloadImage: tl("Download image"),
			downloadTable: tl("Download table"),
			downloadTableAsCsv: tl("Download table as CSV"),
			downloadTableAsMarkdown: tl("Download table as Markdown"),
			exitFullscreen: tl("Exit fullscreen"),
			externalLinkWarning: tl("You're about to visit an external website."),
			imageNotAvailable: tl("Image not available"),
			mermaidFormatMmd: "MMD",
			mermaidFormatPng: "PNG",
			mermaidFormatSvg: "SVG",
			openExternalLink: tl("Open external link?"),
			openLink: tl("Open link"),
			tableFormatCsv: "CSV",
			tableFormatMarkdown: "Markdown",
			tableFormatTsv: "TSV",
			viewFullscreen: tl("View fullscreen"),
		}),
		[tl]
	);
}
