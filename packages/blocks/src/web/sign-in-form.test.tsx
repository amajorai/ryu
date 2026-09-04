import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import SignInForm from "./sign-in-form.tsx";

test("secondary sign-in methods live under More options", () => {
	const html = renderToStaticMarkup(
		<SignInForm
			onDeviceApproval={() => undefined}
			onForgotPassword={() => undefined}
			onGoogle={() => undefined}
			onPasskey={() => undefined}
			onSSO={() => undefined}
			onSwitchToSignUp={() => undefined}
			onToggleMagicLink={() => undefined}
			showForgotPassword
		/>
	);

	expect(html).toContain("More options");
	expect(html).toContain('data-slot="accordion"');
	const rememberIndex = html.indexOf("Remember this device for 30 days");
	expect(rememberIndex).toBeLessThan(html.indexOf(">Sign in<"));
	expect(html).toContain("flex items-center gap-2");
	expect(html).toContain("mb-6 flex items-center gap-2");
	expect(html).toContain(
		"overflow-visible rounded-none border-0 bg-transparent shadow-none"
	);
	expect(html).toContain(
		"border-0 bg-transparent shadow-none hover:bg-transparent hover:shadow-none"
	);
});
