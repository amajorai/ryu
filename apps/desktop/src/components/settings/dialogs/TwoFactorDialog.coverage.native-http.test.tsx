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
	settle,
	submit,
	text,
	type,
	until as untilPage,
} from "../account-billing.native-http.dom.ts";
import {
	authenticatorCode,
	signUp,
	startAccountPeer,
} from "../account-billing.native-http.helpers.ts";

// Mounts the shipping Account tab, whose two-factor row is the shipping
// TwoFactorDialog, against a REAL Better Auth server (bearer + twoFactor, the
// production plugin options) on a native Bun socket. Enrollment uses the setup
// key the dialog shows to compute an authenticator code independently, backup
// codes are compared with the server's own store, and every password is
// checked by the server's real hash. Nothing in the dialog is mocked; the only
// injected failure is a refused clipboard write.
installAccountBillingDom();
setDefaultTimeout(30_000);

const peer = startAccountPeer();
process.env.VITE_APP_BACKEND_URL = peer.origin;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const { sileo } = await import("sileo");
const { queryClient } = await import("@/src/lib/query-client.ts");
const { authClient, getActiveToken, storeSessionToken } = await import(
	"@/lib/auth-client.ts"
);
const { AccountTab } = await import("../AccountTab.tsx");

const PASSWORD = "ada-correct-horse-2026";
const BACKUP_CODE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;
let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let errorToast: ReturnType<typeof spyOn<typeof sileo, "error">>;
let successToast: ReturnType<typeof spyOn<typeof sileo, "success">>;
const runtimeErrors: string[] = [];
let userCounter = 0;

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
function bearer(token: string) {
	return new Headers({ authorization: `Bearer ${token}` });
}
/** The server's stored two-factor flag for a user. */
async function serverTwoFactor(userId: string): Promise<boolean | undefined> {
	const context = await peer.auth.$context;
	const user = await context.internalAdapter.findUserById(userId);
	return (user as { twoFactorEnabled?: boolean } | null)?.twoFactorEnabled;
}
function sorted(values: string[]): string[] {
	return [...values].sort();
}
async function serverBackupCodes(userId: string): Promise<string[]> {
	const view = await peer.auth.api.viewBackupCodes({ body: { userId } });
	return view.backupCodes;
}
/** What the desktop's stored bearer resolves to on the real server now. */
async function storedSessionUser(): Promise<string | null> {
	const token = getActiveToken() ?? "";
	const session = await peer.auth.api.getSession({ headers: bearer(token) });
	return session?.user.email ?? null;
}
async function newAccount() {
	userCounter += 1;
	const email = `ada-${userCounter}@account.example.test`;
	const account = await signUp(peer, {
		email,
		name: `Ada ${userCounter}`,
		password: PASSWORD,
	});
	return { ...account, email };
}
/** Enrolls 2FA through the real server API, as another device would have. */
async function enrollOnServer(token: string) {
	const enabled = await peer.auth.api.enableTwoFactor({
		asResponse: true,
		body: { password: PASSWORD },
		headers: bearer(token),
	});
	const { totpURI } = (await enabled.json()) as { totpURI: string };
	const key = new URL(totpURI).searchParams.get("secret") ?? "";
	const verified = await peer.auth.api.verifyTOTP({
		asResponse: true,
		body: { code: authenticatorCode(key) },
		headers: bearer(token),
	});
	const rotated = verified.headers.get("set-auth-token");
	if (!(verified.ok && rotated)) {
		throw new Error(`Server enrollment failed with ${verified.status}`);
	}
	return rotated;
}
async function mount(token: string, email: string) {
	// The vault lives in memory (sealed natively on desktop): sign in through it.
	await storeSessionToken(token);
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
/** The backup codes the open "Save Backup Codes" step lists. */
function shownBackupCodes(): string[] {
	return [...dialog("Save Backup Codes").querySelectorAll("code")]
		.map((code) => code.textContent?.trim() ?? "")
		.filter((value) => BACKUP_CODE.test(value));
}
function badge() {
	const label = [...document.querySelectorAll('[data-slot="badge"]')].map(
		(item) => item.textContent?.trim()
	);
	return label.find((item) => item === "Enabled" || item === "Disabled");
}

beforeEach(async () => {
	runtimeErrors.length = 0;
	peer.calls.length = 0;
	peer.unknown.length = 0;
	localStorage.clear();
	await navigator.clipboard.writeText("");
	await act(async () => {
		await queryClient.cancelQueries();
		queryClient.clear();
	});
	errorToast = spyOn(sileo, "error");
	successToast = spyOn(sileo, "success");
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	document.body.replaceChildren();
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

test("Authenticator setup key and its copy button carry the secret the server minted, and that key's code enrolls the account without signing the desktop out", async () => {
	const ada = await newAccount();
	await mount(ada.token, ada.email);
	expect(badge()).toBe("Disabled");

	await click(button("Enable 2FA"));
	const passwordStep = dialog("Enable Two-Factor Authentication");
	const password = input(`[id="2fa-password"]`, passwordStep);
	expect(button("Continue", passwordStep).disabled).toBe(true);

	// A wrong password is refused by the server's real hash check.
	await type(password, "not-my-password-1");
	await submit(password.form);
	await until(
		() => errorTitles().includes("Invalid password"),
		"wrong password was not refused"
	);
	expect(hasDialog("Enable Two-Factor Authentication")).toBe(true);
	expect(
		await peer.auth.api
			.viewBackupCodes({ body: { userId: ada.userId } })
			.catch(() => null)
	).toBeNull();

	await type(password, PASSWORD);
	await submit(password.form);
	await until(() => hasDialog("Scan QR Code"), "QR step never opened");
	const qr = dialog("Scan QR Code");
	await click(button("Can’t scan? Enter setup key manually", qr));
	const setupKey = input('[aria-label="Authenticator setup key"]', qr);
	const setupUrl = qr.querySelector("code")?.textContent ?? "";
	const minted = new URL(setupUrl).searchParams.get("secret");
	expect(setupKey.readOnly).toBe(true);
	expect(setupKey.value).toBe(minted ?? "missing");
	expect(setupKey.value).toMatch(/^[A-Z2-7]{16,}$/);

	await click(button("Copy authenticator setup key", qr));
	await until(
		() => successTitles().includes("Setup key copied"),
		"setup key copy was not confirmed"
	);
	expect(await navigator.clipboard.readText()).toBe(setupKey.value);

	// A refused clipboard leaves the clipboard alone and says so.
	await navigator.clipboard.writeText("untouched");
	const refused = spyOn(navigator.clipboard, "writeText").mockRejectedValueOnce(
		new Error("clipboard denied")
	);
	await click(button("Copy authenticator setup key", qr));
	await until(
		() => errorTitles().includes("Couldn't copy setup key"),
		"refused copy was not reported"
	);
	refused.mockRestore();
	expect(await navigator.clipboard.readText()).toBe("untouched");

	await click(button("I've scanned it", qr));
	await until(() => hasDialog("Verify Code"), "verify step never opened");
	const verify = dialog("Verify Code");
	const otp = input('[aria-label="Authenticator app code"]', verify);
	const good = authenticatorCode(setupKey.value);
	const wrong = String((Number(good) + 500_000) % 1_000_000).padStart(6, "0");
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value"
		)?.set?.call(otp, wrong);
		otp.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await submit(otp.form);
	await until(
		() => text().includes("Invalid code. Try again."),
		"wrong authenticator code was accepted"
	);
	expect(await serverTwoFactor(ada.userId)).toBe(false);

	await type(otp, good);
	await submit(otp.form);
	await until(() => hasDialog("Save Backup Codes"), "backup codes never shown");
	expect(await serverTwoFactor(ada.userId)).toBe(true);

	// Better Auth rotated the session on enrollment; the desktop must still be
	// signed in as Ada, and the row must say 2FA is on.
	await settle(200);
	expect(await storedSessionUser()).toBe(ada.email);
	await until(() => badge() === "Enabled", "row never reported 2FA enabled");
	expect(maybeButton("Manage 2FA")).toBeDefined();

	// The codes on screen are the ones the server will accept.
	const stored = await serverBackupCodes(ada.userId);
	expect(stored).toHaveLength(10);
	expect(sorted(shownBackupCodes())).toEqual(sorted(stored));
});

test("XXXXX-XXXXX accepts a listed backup code without its hyphen or casing, sends a mismatch back to the codes with a reminder, and Copy all codes copies every code", async () => {
	const ada = await newAccount();
	await mount(ada.token, ada.email);
	await click(button("Enable 2FA"));
	const passwordStep = dialog("Enable Two-Factor Authentication");
	await type(input(`[id="2fa-password"]`, passwordStep), PASSWORD);
	await submit(input(`[id="2fa-password"]`, passwordStep).form);
	await until(() => hasDialog("Scan QR Code"), "QR step never opened");
	const qr = dialog("Scan QR Code");
	await click(button("Can’t scan? Enter setup key manually", qr));
	const key = input('[aria-label="Authenticator setup key"]', qr).value;
	await click(button("I've scanned it", qr));
	await until(() => hasDialog("Verify Code"), "verify step never opened");
	const otp = input(
		'[aria-label="Authenticator app code"]',
		dialog("Verify Code")
	);
	await type(otp, authenticatorCode(key));
	await submit(otp.form);
	await until(() => hasDialog("Save Backup Codes"), "backup codes never shown");
	const stored = await serverBackupCodes(ada.userId);

	await click(button("Copy all codes", dialog("Save Backup Codes")));
	await until(
		() => Boolean(maybeButton("Copied", dialog("Save Backup Codes"))),
		"copy was not acknowledged"
	);
	expect(sorted((await navigator.clipboard.readText()).split("\n"))).toEqual(
		sorted(stored)
	);

	await click(button("I've saved them", dialog("Save Backup Codes")));
	await until(
		() => hasDialog("Confirm Your Backup Codes"),
		"confirm step never opened"
	);
	const confirmStep = dialog("Confirm Your Backup Codes");
	const code = input('input[placeholder="XXXXX-XXXXX"]', confirmStep);
	expect(button("Confirm", confirmStep).disabled).toBe(true);
	await type(code, "ZZZZZ-ZZZZZ");
	await submit(code.form);
	await until(() => hasDialog("Save Backup Codes"), "mismatch did not bounce");
	expect(text()).toContain("These codes are critical");
	expect(errorTitles()).toContain("That code didn't match");

	await click(button("I've saved them", dialog("Save Backup Codes")));
	await until(
		() => hasDialog("Confirm Your Backup Codes"),
		"confirm step never reopened"
	);
	const retry = input(
		'input[placeholder="XXXXX-XXXXX"]',
		dialog("Confirm Your Backup Codes")
	);
	expect(retry.value).toBe("");
	const chosen = stored[3] ?? "";
	await type(retry, chosen.replace("-", "").toLowerCase());
	await submit(retry.form);
	await until(
		() => !hasDialog("Confirm Your Backup Codes"),
		"a listed code was not accepted"
	);
	expect(successTitles()).toContain("Backup codes confirmed");
	expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0);
	// Confirming is local: the server still holds every code, unspent.
	expect(sorted(await serverBackupCodes(ada.userId))).toEqual(sorted(stored));
});

test("Enter your password guards Manage: a wrong password changes nothing, Regenerate replaces the server's codes, and Disable turns 2FA off so the row offers enrollment again", async () => {
	const ada = await newAccount();
	const rotated = await enrollOnServer(ada.token);
	const original = await serverBackupCodes(ada.userId);
	await mount(rotated, ada.email);
	await until(() => badge() === "Enabled", "enrolled account not shown as on");

	await click(button("Manage 2FA"));
	let manage = dialog("Manage Two-Factor Authentication");
	const password = input('input[placeholder="Enter your password"]', manage);
	expect(button("Regenerate Backup Codes", manage).disabled).toBe(true);
	expect(button("Disable 2FA", manage).disabled).toBe(true);

	await type(password, "not-my-password-1");
	await click(button("Disable 2FA", manage));
	await until(
		() => errorTitles().includes("Invalid password"),
		"wrong password was not refused"
	);
	expect(await serverTwoFactor(ada.userId)).toBe(true);
	expect(hasDialog("Manage Two-Factor Authentication")).toBe(true);

	await type(password, PASSWORD);
	await click(button("Regenerate Backup Codes", manage));
	await until(() => hasDialog("Save Backup Codes"), "new codes never shown");
	const regenerated = await serverBackupCodes(ada.userId);
	expect(sorted(shownBackupCodes())).toEqual(sorted(regenerated));
	expect(regenerated.filter((code) => original.includes(code))).toEqual([]);
	await click(button("I've saved them", dialog("Save Backup Codes")));
	const confirmCode = input(
		'input[placeholder="XXXXX-XXXXX"]',
		dialog("Confirm Your Backup Codes")
	);
	await type(confirmCode, regenerated[0] ?? "");
	await submit(confirmCode.form);
	await until(() => !hasDialog("Confirm Your Backup Codes"), "confirm stuck");

	// Reopening Manage starts from an empty password field.
	await click(button("Manage 2FA"));
	manage = dialog("Manage Two-Factor Authentication");
	const again = input('input[placeholder="Enter your password"]', manage);
	expect(again.value).toBe("");
	await type(again, PASSWORD);
	await click(button("Disable 2FA", manage));
	await until(
		() => successTitles().includes("Two-factor authentication disabled"),
		"disable was not confirmed"
	);
	expect(await serverTwoFactor(ada.userId)).toBe(false);
	await until(() => badge() === "Disabled", "row never reported 2FA off");
	expect(await storedSessionUser()).toBe(ada.email);

	// The row now offers enrollment, and the dialog it opens is enrollment.
	await click(button("Enable 2FA"));
	await until(
		() =>
			hasDialog("Enable Two-Factor Authentication") ||
			hasDialog("Manage Two-Factor Authentication"),
		"no dialog opened"
	);
	expect(hasDialog("Enable Two-Factor Authentication")).toBe(true);
	expect(hasDialog("Manage Two-Factor Authentication")).toBe(false);
});
