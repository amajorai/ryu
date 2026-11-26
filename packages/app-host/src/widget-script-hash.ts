// Script admission for a Ryu App WIDGET document: the host lists the sha256 hash of
// every inline script it delivers, and the frame's policy admits a script by that
// hash and by nothing else (see `widget-csp.ts`).
//
// A hash names one exact script text. Unlike a nonce, script that is already
// running in the frame cannot reuse it for other text or for a script loaded from
// an address. The hash is computed here, synchronously, because the srcdoc is built
// inside a render and `crypto.subtle.digest` only answers asynchronously.

const K = new Uint32Array([
	0x42_8a_2f_98, 0x71_37_44_91, 0xb5_c0_fb_cf, 0xe9_b5_db_a5, 0x39_56_c2_5b,
	0x59_f1_11_f1, 0x92_3f_82_a4, 0xab_1c_5e_d5, 0xd8_07_aa_98, 0x12_83_5b_01,
	0x24_31_85_be, 0x55_0c_7d_c3, 0x72_be_5d_74, 0x80_de_b1_fe, 0x9b_dc_06_a7,
	0xc1_9b_f1_74, 0xe4_9b_69_c1, 0xef_be_47_86, 0x0f_c1_9d_c6, 0x24_0c_a1_cc,
	0x2d_e9_2c_6f, 0x4a_74_84_aa, 0x5c_b0_a9_dc, 0x76_f9_88_da, 0x98_3e_51_52,
	0xa8_31_c6_6d, 0xb0_03_27_c8, 0xbf_59_7f_c7, 0xc6_e0_0b_f3, 0xd5_a7_91_47,
	0x06_ca_63_51, 0x14_29_29_67, 0x27_b7_0a_85, 0x2e_1b_21_38, 0x4d_2c_6d_fc,
	0x53_38_0d_13, 0x65_0a_73_54, 0x76_6a_0a_bb, 0x81_c2_c9_2e, 0x92_72_2c_85,
	0xa2_bf_e8_a1, 0xa8_1a_66_4b, 0xc2_4b_8b_70, 0xc7_6c_51_a3, 0xd1_92_e8_19,
	0xd6_99_06_24, 0xf4_0e_35_85, 0x10_6a_a0_70, 0x19_a4_c1_16, 0x1e_37_6c_08,
	0x27_48_77_4c, 0x34_b0_bc_b5, 0x39_1c_0c_b3, 0x4e_d8_aa_4a, 0x5b_9c_ca_4f,
	0x68_2e_6f_f3, 0x74_8f_82_ee, 0x78_a5_63_6f, 0x84_c8_78_14, 0x8c_c7_02_08,
	0x90_be_ff_fa, 0xa4_50_6c_eb, 0xbe_f9_a3_f7, 0xc6_71_78_f2,
]);

const INITIAL_STATE = [
	0x6a_09_e6_67, 0xbb_67_ae_85, 0x3c_6e_f3_72, 0xa5_4f_f5_3a, 0x51_0e_52_7f,
	0x9b_05_68_8c, 0x1f_83_d9_ab, 0x5b_e0_cd_19,
];

function rotr(value: number, bits: number): number {
	return (value >>> bits) | (value << (32 - bits));
}

/** The message with SHA-256 padding: a 0x80 byte, zeros, then the bit length as a
 *  64-bit big-endian number, so the total is a whole number of 64-byte blocks. */
function padded(message: Uint8Array): DataView {
	const total = Math.ceil((message.length + 9) / 64) * 64;
	const bytes = new Uint8Array(total);
	bytes.set(message);
	bytes[message.length] = 0x80;
	const view = new DataView(bytes.buffer);
	view.setUint32(total - 8, Math.floor(message.length / 0x20_00_00_00));
	view.setUint32(total - 4, (message.length << 3) >>> 0);
	return view;
}

function compress(state: Uint32Array, view: DataView, offset: number): void {
	const w = new Uint32Array(64);
	for (let i = 0; i < 16; i += 1) {
		w[i] = view.getUint32(offset + i * 4);
	}
	for (let i = 16; i < 64; i += 1) {
		const a = w[i - 15] ?? 0;
		const b = w[i - 2] ?? 0;
		const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
		const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
		w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
	}
	let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state;
	for (let i = 0; i < 64; i += 1) {
		const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
		const ch = (e & f) ^ (~e & g);
		const t1 = (h + s1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
		const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
		const maj = (a & b) ^ (a & c) ^ (b & c);
		const t2 = (s0 + maj) >>> 0;
		h = g;
		g = f;
		f = e;
		e = (d + t1) >>> 0;
		d = c;
		c = b;
		b = a;
		a = (t1 + t2) >>> 0;
	}
	const next = [a, b, c, d, e, f, g, h];
	for (let i = 0; i < 8; i += 1) {
		state[i] = ((state[i] ?? 0) + (next[i] ?? 0)) >>> 0;
	}
}

/** SHA-256 of the UTF-8 bytes of `text`, base64-encoded. This is the value a
 *  browser compares a `'sha256-...'` source with for an inline script. */
export function sha256Base64(text: string): string {
	const view = padded(new TextEncoder().encode(text));
	const state = new Uint32Array(INITIAL_STATE);
	for (let offset = 0; offset < view.byteLength; offset += 64) {
		compress(state, view, offset);
	}
	let binary = "";
	for (const word of state) {
		binary += String.fromCharCode(
			word >>> 24,
			(word >>> 16) & 0xff,
			(word >>> 8) & 0xff,
			word & 0xff
		);
	}
	return btoa(binary);
}

/** The policy source expression that admits exactly the inline script `text`. */
export function scriptHashSource(text: string): string {
	return `'sha256-${sha256Base64(text)}'`;
}

/** The few DOM members script admission needs, so a test can stand in for them. */
interface ScriptElementLike {
	getAttribute(name: string): string | null;
	remove(): void;
	textContent: string | null;
}

interface ScriptDocumentLike {
	querySelectorAll(selector: "script"): ArrayLike<ScriptElementLike>;
}

/** Attributes that make a script element load its code from an address (`href`
 *  and `xlink:href` are the SVG forms). */
const ADDRESS_ATTRIBUTES = ["src", "href", "xlink:href"] as const;

/**
 * Decide which of the widget's own script elements the frame may run.
 *
 * A script element that names an address is removed: the frame never loads script
 * from anywhere, whatever the scheme (`https:`, `file:`, `data:`, `blob:`). Every
 * other script element keeps its place, and the hash source of its text is
 * returned for the policy. The removal is tidy-up; the policy is the boundary and
 * refuses an addressed script on its own.
 */
export function admitWidgetScripts(doc: ScriptDocumentLike): string[] {
	const sources = new Set<string>();
	for (const script of Array.from(doc.querySelectorAll("script"))) {
		if (ADDRESS_ATTRIBUTES.some((name) => script.getAttribute(name) !== null)) {
			script.remove();
		} else {
			sources.add(scriptHashSource(script.textContent ?? ""));
		}
	}
	return [...sources];
}
