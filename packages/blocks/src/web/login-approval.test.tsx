import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// React DOM decides whether a DOM exists when it first loads. Register one
// before importing it so a sibling DOM test that runs later in the same Bun
// process (login-approval-prompt.test.tsx) still mounts real elements.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
const { QRCode } = await import("@ryu/ui/components/qr-code.tsx");
const { renderToStaticMarkup } = await import("react-dom/server");

afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

describe("login approval QR", () => {
	it("renders a scannable Better Auth verification URL", () => {
		const markup = renderToStaticMarkup(
			<QRCode
				aria-label="Scan this sign-in QR code with Ryu Mobile"
				bgColor="#ffffff"
				fgColor="#000000"
				size={196}
				value="https://app.example/device?user_code=ABCD2345"
			/>
		);

		expect(markup).toContain("Scan this sign-in QR code with Ryu Mobile");
		expect(markup).toContain('viewBox="0 0 196 196"');
	});
});
