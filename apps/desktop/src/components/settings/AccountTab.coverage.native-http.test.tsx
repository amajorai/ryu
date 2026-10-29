import {
	afterAll,
	afterEach,
	beforeEach,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import {
	button,
	click,
	dialog,
	hasDialog,
	input,
	installAccountBillingDom,
	maybeButton,
	submit,
	text,
	type,
	until as untilPage,
} from "./account-billing.native-http.dom.ts";
import {
	createProviderUser,
	signUp,
	startAccountPeer,
} from "./account-billing.native-http.helpers.ts";

// Mounts the shipping Account tab (EmailChangeDialog, PasswordChangeDialog,
// ResendVerificationButton, CopyableId and the shipping step-up prompt) with
// the shipping auth, settings and step-up clients against one native peer:
// `/api/auth/*` is a real Better Auth server, and the account-security
// control-plane routes follow `packages/api/src/routers/user.ts` with a
// one-use, session-bound step-up proof. Effects are read back from the
// server (records, real password hashes, verification state) and by
// remounting, never from the component's own state.
installAccountBillingDom();
setDefaultTimeout(30_000);

const peer = startAccountPeer();
process.env.VITE_APP_BACKEND_URL = peer.origin;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { authClient, TOKEN_KEY } = await import("@/lib/auth-client.ts");
const { AccountTab } = await import("./AccountTab.tsx");

const PASSWORD = "ada-correct-horse-2026";
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
const runtimeErrors: string[] = [];
let counter = 0;

function until(predicate: () => boolean, reason: string, ms = 8000) {
	return untilPage(predicate, reason, ms, () =>
		peer.calls
			.slice(-8)
			.map((call) => `${call.method} ${call.path} ${call.status}`)
			.join("\n")
	);
}
function errorTitles() {
	return errorToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
function successTitles() {
	return successToast.mock.calls.map((call) => String(call[0]?.title ?? ""));
}
function callsTo(method: string, path: string) {
	return peer.calls.filter(
		(call) => call.method === method && call.path.split("?")[0] === path
	);
}
async function passwordAccount(prefix = "ada") {
	counter += 1;
	const email = `${prefix}-${counter}@account.example.test`;
	const account = await signUp(peer, {
		email,
		name: `${prefix} ${counter}`,
		password: PASSWORD,
	});
	return { ...account, email };
}
async function signsIn(email: string, password: string) {
	const response = await peer.auth.api.signInEmail({
		asResponse: true,
		body: { email, password },
	});
	return response.ok;
}
/** Whether the server's stored credential hash accepts `password`. */
async function storedPasswordMatches(userId: string, password: string) {
	const context = await peer.auth.$context;
	const accounts = await context.internalAdapter.findAccounts(userId);
	const hash = accounts.find(
		(account) => account.providerId === "credential"
	)?.password;
	return hash ? await context.password.verify({ hash, password }) : false;
}
async function serverUser(userId: string) {
	const context = await peer.auth.$context;
	return context.internalAdapter.findUserById(userId);
}
async function mount(token: string, email: string) {
	localStorage.setItem(TOKEN_KEY, token);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container, {
		onCaughtError: (error) => runtimeErrors.push(String(error)),
		onRecoverableError: (error) => runtimeErrors.push(String(error)),
		onUncaughtError: (error) => runtimeErrors.push(String(error)),
	});
	await act(async () =>
		root?.render(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(AccountTab)
			)
		)
	);
	// The shared session atom outlives a mount; re-read it for this bearer.
	await act(async () => {
		authClient.$store.notify("$sessionSignal");
	});
	await until(
		() => text().includes(email),
		`Account tab never showed ${email}`
	);
}
async function unmount() {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.replaceChildren();
}
async function remount(token: string, email: string) {
	await unmount();
	await act(async () => {
		queryClient.clear();
	});
	await mount(token, email);
}
/** Answers the shipping "Confirm it's you" prompt with the account password. */
async function confirmWithPassword(password: string) {
	await until(() => hasDialog("Confirm it's you"), "step-up prompt not shown");
	const prompt = dialog("Confirm it's you");
	const field = input('[id="step-up-current-password"]', prompt);
	await type(field, password);
	await submit(field.form);
}

beforeEach(async () => {
	runtimeErrors.length = 0;
	peer.calls.length = 0;
	peer.unknown.length = 0;
	localStorage.clear();
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
});

afterEach(async () => {
	await unmount();
	errorToast.mockRestore();
	successToast.mockRestore();
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case refuses undeclared control-plane routes.
	expect(peer.unknown).toEqual([]);
	// biome-ignore lint/suspicious/noMisplacedAssertion: every case must render without React errors.
	expect(runtimeErrors).toEqual([]);
});

afterAll(() => {
	peer.stop();
	localStorage.clear();
});

test("Email address: new@example.com is sent only after a fresh step-up, a refused address keeps the draft, and the pending change survives a remount until Cancel change withdraws it on the server", async () => {
	const ada = await passwordAccount();
	const ben = await passwordAccount("ben");
	await mount(ada.token, ada.email);

	await click(button("Change Email"));
	let change = dialog("Change Email Address");
	expect(input("#current-email", change).value).toBe(ada.email);
	expect(input("#current-email", change).disabled).toBe(true);
	const newEmail = input('input[placeholder="new@example.com"]', change);
	expect(newEmail.type).toBe("email");
	expect(button("Send Verification", change).disabled).toBe(true);

	// Another account's address: the step-up is answered (a wrong password
	// first), then the server refuses the address itself.
	await type(newEmail, ben.email);
	await submit(newEmail.form);
	await confirmWithPassword("not-my-password-1");
	await until(
		() => text().includes("That password is incorrect."),
		"wrong step-up password was accepted"
	);
	expect(callsTo("POST", "/api/user/initiate-email-change")).toHaveLength(0);
	await confirmWithPassword(PASSWORD);
	await until(
		() => errorTitles().includes("This email address is already in use"),
		"server refusal was not surfaced"
	);
	change = dialog("Change Email Address");
	expect(input('input[placeholder="new@example.com"]', change).value).toBe(
		ben.email
	);
	expect(peer.emailChanges).toEqual([]);

	// The proof was spent on the refused attempt, so a second address asks
	// again before anything is sent.
	const retry = input('input[placeholder="new@example.com"]', change);
	await type(retry, "new@example.com");
	await submit(retry.form);
	await confirmWithPassword(PASSWORD);
	await until(
		() => !hasDialog("Change Email Address"),
		"accepted change left the dialog open"
	);
	expect(successTitles()).toContain(
		"Verification emails sent to both addresses"
	);
	expect(
		callsTo("POST", "/api/user/initiate-email-change").map((call) => [
			call.body,
			call.status,
		])
	).toEqual([
		[{ newEmail: ben.email }, 409],
		[{ newEmail: "new@example.com" }, 200],
	]);
	expect(
		peer.emailChanges.map(({ newEmail: to, oldEmail, status, userId }) => ({
			oldEmail,
			status,
			to,
			userId,
		}))
	).toEqual([
		{
			oldEmail: ada.email,
			status: "pending",
			to: "new@example.com",
			userId: ada.userId,
		},
	]);
	await until(
		() => text().includes("Email change pending"),
		"pending change not shown"
	);
	expect(text()).toContain(
		"Waiting for confirmation from both email addresses"
	);
	expect(maybeButton("Change Email")).toBeUndefined();

	// The pending state is the server's, so a fresh mount shows it again.
	await remount(ada.token, ada.email);
	await until(
		() => text().includes("Email change pending"),
		"pending change lost on remount"
	);

	await click(button("Cancel change"));
	await until(
		() => successTitles().includes("Email change cancelled"),
		"cancel not confirmed"
	);
	await until(
		() => Boolean(maybeButton("Change Email")),
		"row did not return to Change Email"
	);
	expect(text()).not.toContain("Email change pending");
	expect(peer.emailChanges.map((change_) => change_.status)).toEqual([
		"cancelled",
	]);
	// Ben's account never saw a change request.
	expect(
		peer.emailChanges.filter((change_) => change_.userId === ben.userId)
	).toEqual([]);
});

test("Email address: dismissing the step-up prompt sends no change and keeps the typed address", async () => {
	const ada = await passwordAccount();
	await mount(ada.token, ada.email);
	await click(button("Change Email"));
	const change = dialog("Change Email Address");
	const newEmail = input('input[placeholder="new@example.com"]', change);
	await type(newEmail, "kept@example.com");
	await submit(newEmail.form);
	await until(() => hasDialog("Confirm it's you"), "step-up prompt not shown");
	const close = dialog("Confirm it's you").querySelector<HTMLElement>(
		'[data-slot="dialog-close"]'
	);
	if (!close) {
		throw new Error("The account-security prompt has no close control");
	}
	await click(close);
	await until(() => !hasDialog("Confirm it's you"), "prompt did not close");
	await until(
		() => !button("Send Verification", dialog("Change Email Address")).disabled,
		"submit stayed busy after dismissal"
	);
	expect(
		input(
			'input[placeholder="new@example.com"]',
			dialog("Change Email Address")
		).value
	).toBe("kept@example.com");
	expect(callsTo("POST", "/api/user/initiate-email-change")).toEqual([]);
	expect(
		peer.emailChanges.filter((item) => item.userId === ada.userId)
	).toEqual([]);
	expect(errorTitles()).toEqual([]);
});

test("At least 8 characters: short or mismatched passwords never reach the server, and a passwordless account sets one after the emailed confirmation so it can sign in with it", async () => {
	counter += 1;
	const email = `gh-${counter}@account.example.test`;
	const github = await createProviderUser(peer, {
		email,
		name: "GitHub user",
		providerId: "github",
	});
	await mount(github.token, email);
	await until(
		() => text().includes("You sign in with GitHub"),
		"provider sign-in method not described"
	);

	await click(button("Set Password"));
	const setDialog = dialog("Set Password");
	const next = input('input[placeholder="At least 8 characters"]', setDialog);
	const confirm = input('[id="pw-confirm"]', setDialog);
	expect(next.minLength).toBe(8);

	// The field's own constraint stops a short password before any request.
	await type(next, "short1");
	await type(confirm, "short1");
	await submit(next.form);
	expect(next.validity.tooShort).toBe(true);
	expect(next.form?.checkValidity()).toBe(false);
	expect(hasDialog("Set Password")).toBe(true);
	// The dialog's own guard refuses it too when that constraint is bypassed.
	await act(async () => {
		next.form?.dispatchEvent(
			new Event("submit", { bubbles: true, cancelable: true })
		);
	});
	expect(errorTitles()).toContain("Password needs at least 8 characters");

	await type(next, "longenough-1");
	await type(confirm, "longenough-2");
	await submit(next.form);
	expect(errorTitles()).toContain("Passwords do not match");
	expect(callsTo("GET", "/api/step-up/status")).toEqual([]);
	expect(callsTo("POST", "/api/user/set-password")).toEqual([]);

	await type(next, "Correct-horse-9!");
	await type(confirm, "Correct-horse-9!");
	await submit(next.form);
	// No password yet, so the only proof on offer is the emailed link.
	await until(
		() => text().includes("We sent a one-click verification link"),
		"emailed confirmation not offered"
	);
	expect(peer.pendingMagicLinks).toHaveLength(1);
	expect(callsTo("POST", "/api/user/set-password")).toEqual([]);
	peer.openMagicLink();
	await until(
		() => successTitles().includes("Password set"),
		"password was not set after the link was opened",
		12_000
	);
	expect(
		callsTo("POST", "/api/user/set-password").map((call) => call.body)
	).toEqual([{ newPassword: "Correct-horse-9!" }]);
	await until(
		() => text().includes("Password is set"),
		"row did not re-read the password status"
	);
	expect(maybeButton("Change Password")).toBeDefined();
	expect(await storedPasswordMatches(github.userId, "Correct-horse-9!")).toBe(
		true
	);
	expect(await storedPasswordMatches(github.userId, "longenough-1")).toBe(
		false
	);
	expect(await signsIn(email, "Correct-horse-9!")).toBe(true);
	expect(await signsIn(email, "longenough-1")).toBe(false);
});

test("At least 8 characters: a refused change keeps both fields and the retry replaces the account password", async () => {
	const ada = await passwordAccount();
	await mount(ada.token, ada.email);
	await until(() => text().includes("Password is set"), "status not read");
	await click(button("Change Password"));
	const changeDialog = dialog("Change Password");
	const next = input(
		'input[placeholder="At least 8 characters"]',
		changeDialog
	);
	const confirm = input('[id="pw-confirm"]', changeDialog);
	await type(next, "Brand-new-pass-7");
	await type(confirm, "Brand-new-pass-7");
	peer.refuseNext("POST /api/user/set-password", 503, "Service unavailable");
	await submit(next.form);
	await confirmWithPassword(PASSWORD);
	await until(
		() => errorTitles().includes("Service unavailable"),
		"refusal not surfaced"
	);
	expect(hasDialog("Change Password")).toBe(true);
	expect(next.value).toBe("Brand-new-pass-7");
	expect(confirm.value).toBe("Brand-new-pass-7");
	expect(await signsIn(ada.email, PASSWORD)).toBe(true);

	await submit(next.form);
	await until(
		() => successTitles().includes("Password updated"),
		"retry did not update the password"
	);
	await until(() => !hasDialog("Change Password"), "dialog stayed open");
	expect(await signsIn(ada.email, "Brand-new-pass-7")).toBe(true);
	expect(await signsIn(ada.email, PASSWORD)).toBe(false);
});

test("Resend verification sends one real verification mail, refuses repeats through its 60 second cooldown, reports a refused send, and clears its timer on unmount", async () => {
	const ada = await passwordAccount();
	await mount(ada.token, ada.email);
	await until(
		() => text().includes("Please verify your email address"),
		"unverified banner missing"
	);

	// A refused send is reported and leaves the button ready.
	peer.refuseNext(
		"POST /api/auth/send-verification-email",
		503,
		"Mail service unavailable"
	);
	await click(button("Resend"));
	await until(
		() =>
			errorTitles().includes(
				"Failed to send verification email. Please try again."
			) ||
			successTitles().includes("Verification email sent. Check your inbox."),
		"refused send produced no feedback"
	);
	expect(successTitles()).toEqual([]);
	expect(errorTitles()).toContain(
		"Failed to send verification email. Please try again."
	);
	expect(peer.verificationMails).toEqual([]);
	expect(button("Resend").disabled).toBe(false);

	const ticks: Array<() => void> = [];
	const cooldownTimers: unknown[] = [];
	const cleared: unknown[] = [];
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
		callback: () => void,
		ms?: number
	) => {
		if (ms === 1000) {
			ticks.push(callback);
			const timer = realSetInterval(() => undefined, 2 ** 30);
			cooldownTimers.push(timer);
			return timer;
		}
		return realSetInterval(callback, ms);
	}) as typeof setInterval);
	const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(((
		id?: Parameters<typeof clearInterval>[0]
	) => {
		cleared.push(id);
		realClearInterval(id);
	}) as typeof clearInterval);
	try {
		await click(button("Resend"));
		await until(
			() =>
				successTitles().includes("Verification email sent. Check your inbox."),
			"send not confirmed"
		);
		expect(
			callsTo("POST", "/api/auth/send-verification-email").map(
				(call) => call.body
			)
		).toEqual([
			{ callbackURL: "/", email: ada.email },
			{ callbackURL: "/", email: ada.email },
		]);
		expect(peer.verificationMails.map((mail) => mail.email)).toEqual([
			ada.email,
		]);
		const cooling = button("Resend in 60s");
		expect(cooling.disabled).toBe(true);
		await click(cooling);
		expect(peer.verificationMails).toHaveLength(1);

		// Drive the shipping one-second timer through the full cooldown.
		expect(ticks).toHaveLength(1);
		await act(async () => {
			ticks[0]?.();
		});
		expect(maybeButton("Resend in 59s")).toBeDefined();
		for (let second = 0; second < 59; second++) {
			await act(async () => {
				ticks[0]?.();
			});
		}
		expect(button("Resend").disabled).toBe(false);
		expect(cleared).toContain(cooldownTimers[0]);

		// Another send starts a fresh timer, which an unmount must clear.
		await click(button("Resend"));
		await until(() => ticks.length === 2, "second cooldown not started");
		expect(peer.verificationMails).toHaveLength(2);
		expect(cleared).not.toContain(cooldownTimers[1]);
		await unmount();
		expect(cleared).toContain(cooldownTimers[1]);
	} finally {
		intervalSpy.mockRestore();
		clearSpy.mockRestore();
	}

	// The mailed link is real: opening it verifies the account, and the banner
	// is gone on the next mount.
	const link = peer.verificationMails[0]?.url ?? "";
	const opened = await fetch(link, { redirect: "manual" });
	expect(opened.status).toBeLessThan(400);
	expect((await serverUser(ada.userId))?.emailVerified).toBe(true);
	await mount(ada.token, ada.email);
	await until(
		() => !text().includes("Please verify your email address"),
		"verified account still shows the banner"
	);
});

test("User ID copies the signed-in account's server id and reports a refused clipboard without touching it", async () => {
	const ada = await passwordAccount();
	await mount(ada.token, ada.email);
	const copy = button("Copy user ID");
	const shown = copy.parentElement?.querySelector("code")?.textContent;
	expect(shown).toBe(ada.userId);

	await click(copy);
	await until(
		() => successTitles().includes("Copied user ID"),
		"copy not confirmed"
	);
	expect(await navigator.clipboard.readText()).toBe(ada.userId);

	await navigator.clipboard.writeText("previous clipboard");
	const refused = spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
		new Error("clipboard denied")
	);
	await click(copy);
	await until(() => errorTitles().includes("Copy failed"), "refusal hidden");
	refused.mockRestore();
	expect(await navigator.clipboard.readText()).toBe("previous clipboard");
});
