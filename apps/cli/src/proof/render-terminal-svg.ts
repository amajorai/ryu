import { type CapturedFrame, TextAttributes } from "@opentui/core";
import { ryuTheme } from "../ui/theme.ts";

function colorHex(color: {
	toInts: () => [number, number, number, number];
}): string {
	const [red, green, blue] = color.toInts();
	return `#${[red, green, blue]
		.map((channel) => channel.toString(16).padStart(2, "0"))
		.join("")}`;
}

function colorOpacity(color: {
	toInts: () => [number, number, number, number];
}): number {
	return color.toInts()[3] / 255;
}

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function renderTerminalSvg(frame: CapturedFrame): string {
	const cellWidth = 9.6;
	const cellHeight = 20;
	const width = frame.cols * cellWidth;
	const height = frame.rows * cellHeight;
	const background = ryuTheme.colors.background;
	const rows = frame.lines.map((line, rowIndex) => {
		let column = 0;
		const y = rowIndex * cellHeight;
		const spans = line.spans.map((span) => {
			const x = column * cellWidth;
			column += span.width;
			const spanWidth = span.width * cellWidth;
			const alpha = span.bg.toInts()[3];
			const backgroundHex = colorHex(span.bg);
			const backgroundRect =
				alpha > 0 && backgroundHex !== background
					? `<rect x="${x}" y="${y}" width="${spanWidth}" height="${cellHeight}" fill="${backgroundHex}" fill-opacity="${alpha / 255}"/>`
					: "";
			const visibleText = span.text.length > 0;
			const textNode = visibleText
				? `<text x="${x}" y="${y + 15}" fill="${colorHex(span.fg)}" fill-opacity="${colorOpacity(span.fg)}" font-weight="${span.attributes & TextAttributes.BOLD ? 700 : 400}" xml:space="preserve">${escapeXml(span.text)}</text>`
				: "";
			return `${backgroundRect}${textNode}`;
		});
		return spans.join("");
	});
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
		`<rect width="${width}" height="${height}" fill="${background}"/>`,
		`<g font-family="SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="16">${rows.join("")}</g>`,
		"</svg>",
	].join("");
}
