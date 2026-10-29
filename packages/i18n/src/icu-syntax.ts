// ICU message syntax shared by formatting and pack validation. It imports
// nothing, so the catalog-free entries can use it.

/** Index of the brace closing the one at `start`, or -1 when unbalanced. */
export function findClosingBrace(value: string, start: number): number {
	let depth = 0;
	for (let index = start; index < value.length; index += 1) {
		if (value[index] === "{") {
			depth += 1;
		} else if (value[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				return index;
			}
		}
	}
	return -1;
}

export function splitTopLevel(value: string, separator: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "{") {
			depth += 1;
		} else if (value[index] === "}") {
			depth = Math.max(0, depth - 1);
		} else if (value[index] === separator && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

export function parseOptions(value: string): Map<string, string> {
	const options = new Map<string, string>();
	let cursor = 0;
	while (cursor < value.length) {
		while (/\s/u.test(value[cursor] ?? "")) {
			cursor += 1;
		}
		const keyStart = cursor;
		while (cursor < value.length && !/[\s{]/u.test(value[cursor] ?? "")) {
			cursor += 1;
		}
		const key = value.slice(keyStart, cursor);
		while (/\s/u.test(value[cursor] ?? "")) {
			cursor += 1;
		}
		if (!key || value[cursor] !== "{") {
			break;
		}
		const close = findClosingBrace(value, cursor);
		if (close < 0) {
			break;
		}
		options.set(key, value.slice(cursor + 1, close));
		cursor = close + 1;
	}
	return options;
}

/**
 * The argument names a message reads, sorted. Walks the ICU structure, so a
 * select/plural branch body such as `pending {pending}` is text, not an
 * argument; names nested inside branch bodies still count.
 */
export function placeholderNames(value: string): string[] {
	const names = new Set<string>();
	collectPlaceholderNames(value, names);
	return [...names].sort();
}

const ARGUMENT_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/u;

function collectPlaceholderNames(value: string, names: Set<string>): void {
	let cursor = value.indexOf("{");
	while (cursor >= 0) {
		const close = findClosingBrace(value, cursor);
		if (close < 0) {
			return;
		}
		const [rawName = "", type, ...rest] = splitTopLevel(
			value.slice(cursor + 1, close),
			","
		);
		const name = rawName.trim();
		if (ARGUMENT_NAME.test(name)) {
			names.add(name);
			if (type !== undefined && rest.length > 0) {
				for (const body of parseOptions(rest.join(",")).values()) {
					collectPlaceholderNames(body, names);
				}
			}
		}
		cursor = value.indexOf("{", close + 1);
	}
}
