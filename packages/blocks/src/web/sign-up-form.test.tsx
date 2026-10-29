import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SignUpForm from "./sign-up-form.tsx";

test("sign-up checks age before collecting personal details", () => {
	const html = renderToStaticMarkup(<SignUpForm />);

	expect(html).toContain('autoComplete="bday"');
	expect(html).toContain('type="date"');
	expect(html).not.toContain('type="password"');
	expect(html).not.toContain('type="email"');
	expect(html).not.toContain("Sign up with Google");
});

test("sign-up asks for explicit agreement to the Terms and Privacy Policy before any account step", () => {
	const html = renderToStaticMarkup(<SignUpForm />);

	expect(html).toContain('id="accept-terms"');
	expect(html).toContain("Terms of Service");
	expect(html).toContain("Privacy Policy");
	expect(html).toContain("/docs/legal/terms");
	expect(html).toContain("/docs/legal/privacy");
	// The box starts unticked: agreement is an action, never a default.
	expect(html).not.toMatch(/id="accept-terms"[^>]*aria-checked="true"/);
});
