import { afterEach, describe, expect, test } from "bun:test";
import { formatMessage, type MessageValuesInput } from "@ryu/i18n/lite";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { englishPassTranslate } from "./labels.ts";
import {
	CARD_WIDTH_PX,
	type PassFaceEnv,
	passFaceBox,
	waitlistFacePainter,
} from "./paint.ts";
import { certificateFacePainter } from "./paint-certificate.ts";
import { passInline, passIsRtl } from "./paint-direction.ts";
import { wrappedFacePainter } from "./paint-wrapped.ts";

const arabic = {
	direction: "rtl" as const,
	locale: "ar",
	translate(id: string, values?: MessageValuesInput, fallback?: string) {
		return formatMessage(fallback ?? id, values, "ar");
	},
};

// The mark is a `Path2D`, which bun has no implementation of; the recorder
// ignores what `fill` is handed, so a bare class is enough.
globalThis.Path2D ??= class {} as unknown as typeof Path2D;

let mounted = false;
afterEach(() => {
	if (mounted) {
		unregisterActiveI18nRuntime(arabic);
		mounted = false;
	}
});

function mountArabic(): void {
	registerActiveI18nRuntime(arabic);
	mounted = true;
}

interface Painted {
	align: CanvasTextAlign;
	direction: CanvasDirection;
	text: string;
	x: number;
}

/** A 2D context that records every `fillText` with its alignment and base. */
function recordingContext(): {
	ctx: CanvasRenderingContext2D;
	painted: Painted[];
} {
	const painted: Painted[] = [];
	const state: Record<string | symbol, unknown> = {
		direction: "inherit",
		textAlign: "start",
	};
	const ctx = new Proxy(state, {
		get(target, key) {
			if (key === "fillText") {
				return (text: string, x: number) => {
					painted.push({
						align: target.textAlign as CanvasTextAlign,
						direction: target.direction as CanvasDirection,
						text,
						x,
					});
				};
			}
			if (key === "measureText") {
				return (text: string) => ({ width: text.length * 4 });
			}
			if (key in target) {
				return target[key];
			}
			return () => undefined;
		},
		has: () => true,
		set(target, key, value) {
			target[key] = value;
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
	return { ctx, painted };
}

const SCALE = 2;
const env: PassFaceEnv = {
	family: "sans-serif",
	isDark: false,
	palette: {
		border: "#ccc",
		card: "#fff",
		cardForeground: "#000",
		mutedForeground: "#666",
		primary: "#00f",
	},
	scale: SCALE,
};

function paintFront(painter: {
	front(ctx: CanvasRenderingContext2D, env: PassFaceEnv): void;
}): Painted[] {
	const { ctx, painted } = recordingContext();
	painter.front(ctx, env);
	return painted;
}

const waitlist = waitlistFacePainter({
	joined: "May 2026",
	name: "Ada",
	position: 12,
	username: "ada",
});

describe("passInline", () => {
	test("is the identity in LTR", () => {
		const inline = passInline({ scale: SCALE });
		expect(inline.x(70)).toBe(70);
		expect(inline.box(70, 20)).toBe(70);
		expect(inline.boxCss(35, 20)).toBe(35);
		expect([inline.start, inline.end]).toEqual(["left", "right"]);
	});

	test("mirrors anchors and alignments in RTL", () => {
		const inline = passInline({ rtl: true, scale: SCALE });
		const width = CARD_WIDTH_PX * SCALE;
		const box = passFaceBox(SCALE);
		expect(inline.x(box.left)).toBe(box.right);
		expect(inline.x(box.right)).toBe(box.left);
		expect(inline.box(box.left, 56)).toBe(width - box.left - 56);
		expect(inline.boxCss(35, 20)).toBe(CARD_WIDTH_PX - 35 - 20);
		expect([inline.start, inline.end]).toEqual(["right", "left"]);
	});
});

describe("passIsRtl", () => {
	test("follows the UI's direction, except for English-pinned faces", () => {
		expect(passIsRtl()).toBe(false);
		mountArabic();
		expect(passIsRtl()).toBe(true);
		expect(passIsRtl(englishPassTranslate)).toBe(false);
	});
});

describe("face painters", () => {
	test("an English face keeps its physical left anchors", () => {
		const painted = paintFront(waitlist);
		const box = passFaceBox(SCALE);
		const name = painted.find((entry) => entry.text === "Ada");
		const date = painted.find((entry) => entry.text === "May 2026");
		expect(name).toMatchObject({
			align: "left",
			direction: "ltr",
			x: box.left,
		});
		expect(date).toMatchObject({ align: "right", x: box.right });
	});

	test("an Arabic face is RTL-based and mirrored", () => {
		mountArabic();
		const painted = paintFront(waitlist);
		const box = passFaceBox(SCALE);
		expect(painted.every((entry) => entry.direction === "rtl")).toBe(true);
		const name = painted.find((entry) => entry.text === "Ada");
		const date = painted.find((entry) => entry.text === "May 2026");
		const wordmark = painted.find((entry) => entry.text === "Ryu");
		// The date (header meta) moves to the left, the hero starts at the right.
		expect(date).toMatchObject({ align: "left", x: box.left });
		expect(name).toMatchObject({ align: "right", x: box.right });
		expect(wordmark?.align).toBe("right");
		expect(wordmark?.x).toBeLessThan(box.right);
	});

	test("a second stat column sits left of the first in RTL", () => {
		mountArabic();
		const painted = paintFront(
			wrappedFacePainter({
				agentHours: 12,
				level: 3,
				name: "Ada",
				streakCurrent: 3,
				streakLongest: 9,
				topModel: "m",
				totalTokens: 1000,
			})
		);
		const box = passFaceBox(SCALE);
		const tokens = painted.find((entry) => entry.text === "Tokens");
		const hours = painted.find((entry) => entry.text === "Agent hours");
		expect(tokens).toMatchObject({ align: "right", x: box.right });
		expect(hours?.align).toBe("right");
		expect(hours?.x).toBeLessThan(box.right);
		expect(hours?.x).toBeGreaterThan(box.left);
	});

	test("the English-pinned certificate stays LTR under an Arabic UI", () => {
		mountArabic();
		const painted = paintFront(
			certificateFacePainter({
				holderName: "Ada",
				issuerName: "Ryu",
				levelName: "Level 1",
				official: true,
				score: 92,
			})
		);
		expect(painted.every((entry) => entry.direction === "ltr")).toBe(true);
		expect(painted.find((entry) => entry.text === "Ada")?.align).toBe("left");
	});
});
