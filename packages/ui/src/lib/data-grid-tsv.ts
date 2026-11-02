// Tab-separated clipboard parsing for the data grid. Split from `data-grid.ts`,
// which re-exports `parseTsv`.

const TRAILING_CR_REGEX = /\r$/;

function countTabs(s: string): number {
	let n = 0;
	for (const char of s) {
		if (char === "\t") {
			n++;
		}
	}
	return n;
}

function shouldKeepTsvRow(row: string[]): boolean {
	return row.length > 1 || row.some((field) => field.length > 0);
}

function pushTsvRow(rows: string[][], row: string[]): void {
	if (shouldKeepTsvRow(row)) {
		rows.push(row);
	}
}

function isQuotedTsvLineBreak(
	char: string | undefined,
	nextChar: string | undefined
): boolean {
	return char === "\n" || (char === "\r" && nextChar === "\n");
}

function parseQuotedTsv(text: string): string[][] {
	const rows: string[][] = [];
	let currentRow: string[] = [];
	let currentField = "";
	let inQuotes = false;
	let i = 0;

	while (i < text.length) {
		const char = text[i];
		const nextChar = text[i + 1];

		if (inQuotes && char === '"' && nextChar === '"') {
			currentField += '"';
			i += 2;
			continue;
		}
		if (inQuotes && char === '"') {
			inQuotes = false;
			i++;
			continue;
		}
		if (inQuotes) {
			currentField += char;
			i++;
			continue;
		}
		if (char === '"' && currentField === "") {
			inQuotes = true;
			i++;
			continue;
		}
		if (char === "\t") {
			currentRow.push(currentField);
			currentField = "";
			i++;
			continue;
		}
		if (isQuotedTsvLineBreak(char, nextChar)) {
			currentRow.push(currentField);
			pushTsvRow(rows, currentRow);
			currentRow = [];
			currentField = "";
			i += char === "\r" ? 2 : 1;
			continue;
		}

		currentField += char;
		i++;
	}

	currentRow.push(currentField);
	pushTsvRow(rows, currentRow);
	return rows;
}

function tsvColumnCount(lines: string[], fallbackColumnCount: number): number {
	let maxTabCount = 0;
	for (const line of lines) {
		const n = countTabs(line);
		if (n > maxTabCount) {
			maxTabCount = n;
		}
	}
	return maxTabCount > 0 ? maxTabCount + 1 : fallbackColumnCount;
}

function parsePlainTsv(text: string, fallbackColumnCount: number): string[][] {
	const lines = text
		.split("\n")
		.map((line) => line.replace(TRAILING_CR_REGEX, ""));
	const columnCount = tsvColumnCount(lines, fallbackColumnCount);
	if (columnCount <= 0) {
		return [];
	}

	const expectedTabCount = columnCount - 1;
	const rows: string[][] = [];
	let buf = "";
	let bufTabCount = 0;

	for (const line of lines) {
		const tc = countTabs(line);

		if (tc === expectedTabCount) {
			if (buf && bufTabCount === expectedTabCount) {
				rows.push(buf.split("\t"));
			}
			buf = "";
			bufTabCount = 0;
			rows.push(line.split("\t"));
		} else {
			buf = buf ? `${buf}\n${line}` : line;
			bufTabCount += tc;
			if (bufTabCount === expectedTabCount) {
				rows.push(buf.split("\t"));
				buf = "";
				bufTabCount = 0;
			}
		}
	}

	if (buf && bufTabCount === expectedTabCount) {
		rows.push(buf.split("\t"));
	}

	return rows.length > 0
		? rows
		: lines.filter((l) => l.length > 0).map((l) => l.split("\t"));
}

export function parseTsv(
	text: string,
	fallbackColumnCount: number
): string[][] {
	if (text.startsWith('"') || text.includes('\t"')) {
		return parseQuotedTsv(text);
	}
	return parsePlainTsv(text, fallbackColumnCount);
}
