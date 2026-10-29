import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	createQRCodeGeometry,
	type ErrorCorrectionLevel,
} from "../lib/qr-code.ts";
import { PassQrBack } from "./pass-qr-back.tsx";

describe("PassQrBack", () => {
	test("renders a high-correction dot QR with the Ryu center mark", () => {
		// The invite URL is a sensitive value: the QR stays masked until the
		// owning pass reveals it, exactly as InvitePass and WaitlistPass do.
		const hidden = renderToStaticMarkup(
			<PassQrBack
				caption="Scan to share"
				metalTheme="light"
				seed="pilot"
				value="https://ryuhq.com/r/ABCD2345"
			/>
		);
		expect(hidden).toContain("Invite QR hidden");
		expect(hidden).toContain('aria-label="Reveal invite QR"');
		expect(hidden).not.toContain('aria-label="Scan to share"');
		expect(hidden).not.toContain('viewBox="0 0 224 224"');
		// Only the reveal button's eye glyph remains; no QR module dots.
		expect((hidden.match(/<circle/g) ?? []).length).toBeLessThanOrEqual(1);

		const markup = renderToStaticMarkup(
			<PassQrBack
				caption="Scan to share"
				metalTheme="light"
				onRevealToggle={() => undefined}
				revealed
				seed="pilot"
				value="https://ryuhq.com/r/ABCD2345"
			/>
		);

		expect(markup).not.toContain("Invite QR hidden");
		expect(markup).toContain('aria-label="Hide invite QR"');
		expect(markup).toContain('aria-pressed="true"');
		expect(markup).toContain('aria-label="Scan to share"');
		expect(markup).toContain('viewBox="0 0 224 224"');
		expect((markup.match(/<circle/g) ?? []).length).toBeGreaterThan(20);
		// High correction (H) is what leaves room for the center mark: the QR's
		// own dots match an H encoding of the URL, not the default M or a low L.
		const qr = markup.slice(
			markup.indexOf('<svg aria-label="Scan to share"'),
			markup.indexOf(
				"</svg>",
				markup.indexOf('<svg aria-label="Scan to share"')
			)
		);
		const qrDots = (qr.match(/<circle/g) ?? []).length;
		const url = "https://ryuhq.com/r/ABCD2345";
		const dotCount = (level: ErrorCorrectionLevel): number => {
			const geometry = createQRCodeGeometry(url, 224, level);
			if (!geometry) {
				throw new Error("The native QR encoder did not produce geometry");
			}
			return geometry.circles.length;
		};
		expect(qrDots).toBe(dotCount("H"));
		expect(qrDots).not.toBe(dotCount("M"));
		expect(qrDots).not.toBe(dotCount("L"));
		expect(markup).toContain("Scan to share");
		expect((markup.match(/<path/g) ?? []).length).toBeGreaterThan(0);
		expect((markup.match(/<ellipse/g) ?? []).length).toBeGreaterThan(0);
	});

	test("does not pretend to encode a link while the destination is missing", () => {
		const markup = renderToStaticMarkup(
			<PassQrBack caption="Scan to invite" seed="pilot" value={null} />
		);

		expect(markup).toContain("Invite link is preparing");
		expect(markup).not.toContain('viewBox="0 0 224 224"');
	});
});
