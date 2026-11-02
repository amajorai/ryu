// The folded view a PII/secret scanner runs beside the as-written text, so a
// value disguised with fullwidth letters, invisible characters, or look-alike
// digits, dashes and spaces is still recognised. Pure and browser-safe.
//
// Same fold as the public-share guard (`foldShareText` in the API package) and
// Core's `redaction_fold::fold`; keep the three identical.

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

/** NFKC per code point, drop invisible characters, then fold space, dash and
 * digit variants to ASCII. Idempotent; plain ASCII text is returned unchanged. */
export function foldRedactionText(input: string): string {
	return dropIgnorable(nfkcPerCodePoint(input))
		.replace(SPACE_SEPARATOR, " ")
		.replace(DASH, "-")
		.replace(NON_ASCII_DECIMAL_DIGIT, foldDigit);
}
