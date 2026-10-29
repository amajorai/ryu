import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OTPCodeDisplay, OTPInput } from "./otp-input.tsx";

test("device display normalizes the code and exposes a read-only accessible value", () => {
	const markup = renderToStaticMarkup(
		<OTPCodeDisplay aria-label="Device code" code="abcd-1234" />
	);
	expect(markup).toContain('aria-label="Device code"');
	expect(markup).toContain('readOnly=""');
	expect(markup).toContain('value="ABCD1234"');
	expect(markup).toContain('tabindex="-1"');
	expect(markup).toContain('autoComplete="off"');
	expect(markup).toContain("pointer-events-none");
	expect(markup.match(/data-filled="true"/g)).toHaveLength(8);
	expect(markup).not.toContain("opacity-50");
});

test("compact displays use the existing slot layout at a smaller size", () => {
	const markup = renderToStaticMarkup(
		<OTPCodeDisplay code="ABCD1234" size="compact" />
	);
	expect(markup).toContain("h-9 w-9");
	expect(markup).toContain("text-sm");
	expect(markup).toContain("gap-1");
});

test("display uses the returned code length and hides an empty code", () => {
	const markup = renderToStaticMarkup(<OTPCodeDisplay code="abc123" />);
	expect(markup.match(/data-filled="true"/g)).toHaveLength(6);
	expect(renderToStaticMarkup(<OTPCodeDisplay code="---" />)).toBe("");
});

test("editable OTP entry retains native autofill and an empty input value", () => {
	const markup = renderToStaticMarkup(<OTPInput length={6} value="123456" />);
	expect(markup).toContain('autoComplete="one-time-code"');
	expect(markup).toContain('value=""');
	expect(markup).not.toContain('readOnly=""');
	expect(markup).not.toContain('tabindex="-1"');
});
