import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PasswordStrengthMeter } from "./password-strength.tsx";

describe("PasswordStrengthMeter", () => {
	test("renders four bars and marks every strong requirement", () => {
		const html = renderToStaticMarkup(
			<PasswordStrengthMeter value="RyuLaunch!9" />
		);
		expect(html).toContain('data-strength-score="4"');
		expect(html).toContain('data-strength-label="Strong"');
		expect(html.match(/data-testid="password-strength-meter"/g)).toHaveLength(
			1
		);
		expect(html).toContain("At least 8 characters");
		expect(html).toContain("One symbol");
	});

	test("starts empty without hiding the requirements", () => {
		const html = renderToStaticMarkup(<PasswordStrengthMeter value="" />);
		expect(html).toContain('data-strength-score="0"');
		expect(html).toContain('data-strength-label="Too weak"');
		expect(html).toContain('role="progressbar"');
	});
});
