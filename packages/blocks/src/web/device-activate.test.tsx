import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import DeviceActivate from "./device-activate.tsx";

test("renders the device code entry as grouped alphanumeric OTP slots", () => {
	const markup = renderToStaticMarkup(<DeviceActivate userCode="ABCD1234" />);

	expect(markup).toContain('aria-label="Device activation code"');
	expect(markup.match(/data-filled="true"/g)).toHaveLength(8);
	expect(markup.match(/data-otp-separator/g)).toHaveLength(1);
	expect(markup).toContain("Continue");
});

test("supports a linked device code with a different length", () => {
	const markup = renderToStaticMarkup(
		<DeviceActivate length={6} userCode="ABCD12" />
	);

	expect(markup.match(/data-otp-index="\d+"/g)).toHaveLength(6);
	expect(markup.match(/data-filled="true"/g)).toHaveLength(6);
	expect(markup.match(/data-otp-separator/g)).toHaveLength(1);
});
