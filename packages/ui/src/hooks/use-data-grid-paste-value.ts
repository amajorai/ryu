import {
	type ClipboardCellValue,
	DOMAIN_REGEX,
	ISO_DATE_REGEX,
	TRUTHY_BOOLEANS,
	VALID_BOOLEANS,
} from "@ryu/ui/hooks/use-data-grid-model.ts";
import { matchSelectOption, parsePastedDate } from "@ryu/ui/lib/data-grid.ts";
import {
	clipboardFileEntriesSchema,
	clipboardStringListSchema,
	clipboardTextValueSchema,
	describeClipboardTextValue,
} from "@ryu/ui/lib/data-grid-clipboard.ts";
import type { CellOpts, FileCellData } from "@ryu/ui/types/data-grid.ts";

/** Convert one pasted clipboard string into a value for a column configured as `cellOpts`. */
function convertPastedCellValue(
	pastedValue: string,
	cellOpts: CellOpts | undefined
): { processedValue: ClipboardCellValue; shouldSkip: boolean } {
	const cellVariant = cellOpts?.variant;

	let processedValue: ClipboardCellValue = pastedValue;
	let shouldSkip = false;

	switch (cellVariant) {
		case "formula": {
			// Formula columns are computed and never written.
			shouldSkip = true;
			break;
		}

		case "number": {
			if (pastedValue) {
				const num = Number.parseFloat(pastedValue);
				if (Number.isNaN(num)) {
					shouldSkip = true;
				} else {
					processedValue = num;
				}
			} else {
				processedValue = null;
			}
			break;
		}

		case "checkbox": {
			if (pastedValue) {
				const lower = pastedValue.toLowerCase();
				if (VALID_BOOLEANS.has(lower)) {
					processedValue = TRUTHY_BOOLEANS.has(lower);
				} else {
					shouldSkip = true;
				}
			} else {
				processedValue = false;
			}
			break;
		}

		case "date": {
			if (pastedValue) {
				const date = parsePastedDate(pastedValue);
				if (date === null) {
					shouldSkip = true;
				} else {
					processedValue = date;
				}
			} else {
				processedValue = null;
			}
			break;
		}

		case "select": {
			const options = cellOpts?.options ?? [];
			if (pastedValue) {
				const matched = matchSelectOption(pastedValue, options);
				if (matched) {
					processedValue = matched;
				} else {
					shouldSkip = true;
				}
			} else {
				processedValue = null;
			}
			break;
		}

		case "multi-select": {
			const options = cellOpts?.options ?? [];
			let values: string[] = [];
			try {
				const parsed = clipboardStringListSchema.safeParse(
					JSON.parse(pastedValue)
				);
				if (parsed.success) {
					values = parsed.data;
				}
			} catch {
				values = pastedValue ? pastedValue.split(",").map((v) => v.trim()) : [];
			}

			const validated = values
				.map((v) => matchSelectOption(v, options))
				.filter((value): value is string => Boolean(value));

			if (values.length > 0 && validated.length === 0) {
				shouldSkip = true;
			} else {
				processedValue = validated;
			}
			break;
		}

		case "file": {
			if (pastedValue) {
				try {
					const parsed = clipboardFileEntriesSchema.safeParse(
						JSON.parse(pastedValue)
					);
					if (parsed.success) {
						const validFiles = parsed.data.filter(
							(file): file is FileCellData => file !== undefined
						);
						if (parsed.data.length > 0 && validFiles.length === 0) {
							shouldSkip = true;
						} else {
							processedValue = validFiles;
						}
					} else {
						shouldSkip = true;
					}
				} catch {
					shouldSkip = true;
				}
			} else {
				processedValue = [];
			}
			break;
		}

		case "url": {
			if (pastedValue) {
				const firstChar = pastedValue[0];
				if (firstChar === "[" || firstChar === "{") {
					shouldSkip = true;
				} else {
					try {
						new URL(pastedValue);
						processedValue = pastedValue;
					} catch {
						if (DOMAIN_REGEX.test(pastedValue)) {
							processedValue = pastedValue;
						} else {
							shouldSkip = true;
						}
					}
				}
			} else {
				processedValue = "";
			}
			break;
		}

		default: {
			if (!pastedValue) {
				processedValue = "";
				break;
			}

			if (ISO_DATE_REGEX.test(pastedValue)) {
				const date = new Date(pastedValue);
				if (!Number.isNaN(date.getTime())) {
					processedValue = date.toLocaleDateString();
					break;
				}
			}

			const firstChar = pastedValue[0];
			if (
				firstChar === "[" ||
				firstChar === "{" ||
				firstChar === "t" ||
				firstChar === "f"
			) {
				try {
					const parsed = clipboardTextValueSchema.safeParse(
						JSON.parse(pastedValue)
					);
					if (parsed.success) {
						processedValue = describeClipboardTextValue(parsed.data);
					}
				} catch {
					const lower = pastedValue.toLowerCase();
					if (lower === "true" || lower === "false") {
						processedValue = lower === "true" ? "Checked" : "Unchecked";
					}
				}
			}
		}
	}

	return { processedValue, shouldSkip };
}

export { convertPastedCellValue };
