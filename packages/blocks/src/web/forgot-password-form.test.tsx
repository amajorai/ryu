import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ForgotPasswordForm from "./forgot-password-form.tsx";

test("describes password recovery as an OTP flow", () => {
	const html = renderToStaticMarkup(
		<ForgotPasswordForm captcha={<div data-testid="captcha-slot" />} />
	);
	const normalized = html.replaceAll("&#x27;", "'");

	expect(normalized).toContain("We'll send you a code to reset your password");
	expect(normalized).toContain("Send reset code");
	expect(normalized).toContain('data-testid="captcha-slot"');
	expect(normalized).not.toContain("Send reset email");
});
