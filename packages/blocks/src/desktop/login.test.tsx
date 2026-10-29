import { expect, test } from "bun:test";
import { I18nProvider } from "@ryu/i18n/react";
import { renderToStaticMarkup } from "react-dom/server";
import { LoginView } from "./login.tsx";

test("keeps Core download promotion off the browser welcome screen", () => {
	const html = renderToStaticMarkup(
		<LoginView onContinueAsGuest={() => undefined} />
	);

	expect(html).toContain("Try Ryu without an account");
	expect(html).not.toContain("Download Ryu Core for this computer");
	expect(html).not.toContain("standalone local runtime");
});

test("omits the guest action when the host disables guest mode", () => {
	const html = renderToStaticMarkup(<LoginView />);

	expect(html).not.toContain("Try Ryu without an account");
});

test("localizes the welcome copy through the shared catalog", () => {
	const html = renderToStaticMarkup(
		<I18nProvider initialPackId="official/es">
			<LoginView onContinueAsGuest={() => undefined} />
		</I18nProvider>
	);

	expect(html).toContain("Hola, soy Ryu");
	expect(html).toContain("Tu fantasma amigable que vive en tu escritorio");
	expect(html).toContain("Comenzar");
	expect(html).toContain("Probar Ryu sin una cuenta");
	expect(html).not.toContain("Hey, I'm Ryu");
});

test("shows a copy sign-in link button after device authorization starts", () => {
	const html = renderToStaticMarkup(
		<LoginView
			hasVerificationUri
			userCode="ABCD1234"
			verificationUri="https://example.test/device?user_code=ABCD1234"
			waiting
		/>
	);

	expect(html).toContain("Copy sign-in link");
	expect(html).toContain("Open");
	expect(html).toContain('aria-label="Device sign-in code"');
	expect(html).not.toContain("Copy device code");
	expect(html).not.toContain("bg-muted/40");
	expect(html).not.toContain("Cancel");
	expect(html.match(/data-filled="true"/g)).toHaveLength(8);
});

test("does not offer a copy link before a verification URL exists", () => {
	const html = renderToStaticMarkup(
		<LoginView hasVerificationUri userCode="ABCD1234" waiting />
	);

	expect(html).not.toContain("Copy sign-in link");
	expect(html).toContain("Open");
});
