import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OTPCodeDisplay } from "./otp-input.tsx";

test("renders a normalized device code as read-only OTP slots", () => {
	const markup = renderToStaticMarkup(
		<OTPCodeDisplay aria-label="Device sign-in code" code="abcd-1234" />
	);

	expect(markup).toContain('aria-label="Device sign-in code"');
	expect(markup).toContain('readOnly=""');
	expect(markup).toContain('value="ABCD1234"');
	expect(markup.match(/data-filled="true"/g)).toHaveLength(8);
	expect(markup.match(/data-otp-separator/g)).toHaveLength(1);
	expect(markup).not.toContain("opacity-50");
});

test("uses compact slots for codes inside narrow panels", () => {
	const markup = renderToStaticMarkup(
		<OTPCodeDisplay code="ABCD1234" size="compact" />
	);

	expect(markup).toContain("h-9 w-9 rounded-lg text-sm");
	expect(markup).toContain("gap-1");
	expect(markup.match(/data-otp-separator/g)).toHaveLength(1);
});

test("renders shorter device codes at their actual length", () => {
	const markup = renderToStaticMarkup(<OTPCodeDisplay code="abc123" />);

	expect(markup.match(/data-otp-index="\d+"/g)).toHaveLength(6);
	expect(markup.match(/data-otp-separator/g)).toHaveLength(1);
});
