import { expect, test } from "bun:test";
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
