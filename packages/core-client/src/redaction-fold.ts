// The folded view a PII/secret scanner runs beside the as-written text, so a
// value disguised with fullwidth letters, invisible characters, or look-alike
// digits, dashes and spaces is still recognised. Pure and browser-safe.
//
// Same fold as the public-share guard (`foldShareText` in the API package) and
// Core's `redaction_fold::fold`; keep the three identical. The shared fixture
// `fixtures/portable-history-fold-v1.json` pins the parity.

/** Default-ignorable code points: zero-width, bidi, fillers, variation
 * selectors and the TAG block. They split a run without rendering. A range
 * table rather than a character class, since several are combining marks. */
const IGNORABLE_RANGES: readonly (readonly [number, number])[] = [
	[0x00_ad, 0x00_ad],
	[0x03_4f, 0x03_4f],
	[0x06_1c, 0x06_1c],
	[0x11_5f, 0x11_60],
	[0x17_b4, 0x17_b5],
	[0x18_0b, 0x18_0f],
	[0x20_0b, 0x20_0f],
	[0x20_2a, 0x20_2e],
	[0x20_60, 0x20_6f],
	[0x31_64, 0x31_64],
	[0xfe_00, 0xfe_0f],
	[0xfe_ff, 0xfe_ff],
	[0xff_a0, 0xff_a0],
	[0x1_bc_a0, 0x1_bc_a3],
	[0x1_d1_73, 0x1_d1_7a],
	[0xe_00_00, 0xe_0f_ff],
];

function isIgnorable(codePoint: number): boolean {
	return IGNORABLE_RANGES.some(
		([low, high]) => codePoint >= low && codePoint <= high
	);
}

function dropIgnorable(text: string): string {
	let kept = "";
	for (const character of text) {
		if (!isIgnorable(character.codePointAt(0) ?? 0)) {
			kept += character;
		}
	}
	return kept;
}

const SPACE_SEPARATOR = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;
const DASH =
	/[\u02d7\u058a\u05be\u1400\u1806\u2010-\u2015\u2043\u2212\u2796\u2e17\u2e1a\u2e3a\u2e3b\u2e40\u2e5d\u301c\u3030\u30a0\ufe31\ufe32\ufe58\ufe63\u{10ead}]/gu;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII_DECIMAL_DIGIT = /(?![0-9])\p{Nd}/gu;

/** `Nd` digits come in runs of ten ordered 0-9 and adjacent runs each start
 * at zero, so the value is the offset from the start of the contiguous run. */
function foldDigit(digit: string): string {
	const codePoint = digit.codePointAt(0) ?? 0;
	let start = codePoint;
	for (let step = 0; step < 64; step += 1) {
		if (!DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) {
			break;
		}
		start -= 1;
	}
	return String((codePoint - start) % 10);
}

/** Cyrillic and Greek letters drawn like an ASCII letter. Folded only inside a
 * token that already holds an ASCII letter or digit, so a mixed-script address
 * (`ava@\u0435xample.com`) reads as ASCII while Russian or Greek prose is left
 * alone. Same table as Core's `redaction_fold::CONFUSABLES`. */
const CONFUSABLES: ReadonlyMap<number, string> = new Map([
	[0x03_91, "A"],
	[0x03_92, "B"],
	[0x03_95, "E"],
	[0x03_96, "Z"],
	[0x03_97, "H"],
	[0x03_99, "I"],
	[0x03_9a, "K"],
	[0x03_9c, "M"],
	[0x03_9d, "N"],
	[0x03_9f, "O"],
	[0x03_a1, "P"],
	[0x03_a4, "T"],
	[0x03_a5, "Y"],
	[0x03_a7, "X"],
	[0x03_b1, "a"],
	[0x03_b9, "i"],
	[0x03_ba, "k"],
	[0x03_bd, "v"],
	[0x03_bf, "o"],
	[0x03_c1, "p"],
	[0x03_c5, "u"],
	[0x03_c7, "x"],
	[0x04_05, "S"],
	[0x04_06, "I"],
	[0x04_08, "J"],
	[0x04_10, "A"],
	[0x04_12, "B"],
	[0x04_15, "E"],
	[0x04_1a, "K"],
	[0x04_1c, "M"],
	[0x04_1d, "H"],
	[0x04_1e, "O"],
	[0x04_20, "P"],
	[0x04_21, "C"],
	[0x04_22, "T"],
	[0x04_23, "Y"],
	[0x04_25, "X"],
	[0x04_30, "a"],
	[0x04_35, "e"],
	[0x04_3e, "o"],
	[0x04_40, "p"],
	[0x04_41, "c"],
	[0x04_43, "y"],
	[0x04_45, "x"],
	[0x04_55, "s"],
	[0x04_56, "i"],
	[0x04_58, "j"],
	[0x04_ae, "Y"],
	[0x04_bb, "h"],
	[0x04_c0, "I"],
	[0x04_cf, "l"],
	[0x05_01, "d"],
	[0x05_1a, "Q"],
	[0x05_1b, "q"],
	[0x05_1c, "W"],
	[0x05_1d, "w"],
]);

const IDEOGRAPHIC_FULL_STOP = 0x30_02;
/** ASCII whitespace plus NEL and the line and paragraph separators: what ends a
 * token once space separators have been folded to a space. */
const TOKEN_SEPARATORS = new Set([
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0x20_28, 0x20_29,
]);
const ASCII_ALPHANUMERIC = /[A-Za-z0-9]/;
const COMBINING_MARK = /^[\p{Mn}\p{Me}]$/u;

function foldToken(token: string): string {
	if (!ASCII_ALPHANUMERIC.test(token)) {
		return token;
	}
	let folded = "";
	for (const character of token) {
		const codePoint = character.codePointAt(0) ?? 0;
		folded +=
			codePoint === IDEOGRAPHIC_FULL_STOP
				? "."
				: (CONFUSABLES.get(codePoint) ?? character);
	}
	return folded;
}

/** Fold look-alike letters and the ideographic full stop in every token that
 * mixes them with ASCII letters or digits. */
function foldMixedScriptTokens(text: string): string {
	let folded = "";
	let token = "";
	for (const character of text) {
		if (TOKEN_SEPARATORS.has(character.codePointAt(0) ?? 0)) {
			folded += foldToken(token) + character;
			token = "";
		} else {
			token += character;
		}
	}
	return folded + foldToken(token);
}

/** Drop combining marks (`Mn`, `Me`) that sit on an ASCII character, so an
 * accent stacked on an address or a number no longer splits the match. */
function dropMarksOnAscii(text: string): string {
	let kept = "";
	let onAscii = false;
	for (const character of text) {
		if (onAscii && COMBINING_MARK.test(character)) {
			continue;
		}
		onAscii = (character.codePointAt(0) ?? 0) < 0x80;
		kept += character;
	}
	return kept;
}

/** NFKC applied one code point at a time, so an ASCII letter never composes
 * with a following combining mark (an ASCII run in the input stays an ASCII
 * run in the folded view). */
function nfkcPerCodePoint(text: string): string {
	let folded = "";
	for (const character of text) {
		folded += character.normalize("NFKC");
	}
	return folded;
}

/** NFKC per code point, drop invisible characters, fold space, dash and digit
 * variants to ASCII, fold look-alike letters and the ideographic full stop in
 * mixed-script tokens, then drop combining marks sitting on ASCII. Idempotent;
 * plain ASCII text is returned unchanged. */
export function foldRedactionText(input: string): string {
	const spaced = dropIgnorable(nfkcPerCodePoint(input))
		.replace(SPACE_SEPARATOR, " ")
		.replace(DASH, "-")
		.replace(NON_ASCII_DECIMAL_DIGIT, foldDigit);
	return dropMarksOnAscii(foldMixedScriptTokens(spaced));
}
