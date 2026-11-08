import { afterEach, expect, test } from "bun:test";
import {
	CORE_IDENTITY_CONFLICT_HINT,
	CoreIdentityError,
	setCoreIdentityErrorText,
} from "./core-identity.ts";

afterEach(() => {
	setCoreIdentityErrorText(null);
});

test("the identity failure names the URL and the conflict hint in English by default", () => {
	const error = new CoreIdentityError("http://127.0.0.1:7980");
	expect(error.message).toBe(
		`The process answering at http://127.0.0.1:7980 could not prove it is your Ryu Core, so the CLI did not send it your token. ${CORE_IDENTITY_CONFLICT_HINT}.`
	);
	expect(error.name).toBe("CoreIdentityError");
});

test("a host can render the identity failure in its own locale", () => {
	setCoreIdentityErrorText((url, hint) => `[fr] ${url} | ${hint.length}`);
	expect(new CoreIdentityError("http://[::1]:7980").message).toBe(
		`[fr] http://[::1]:7980 | ${CORE_IDENTITY_CONFLICT_HINT.length}`
	);
	setCoreIdentityErrorText(null);
	expect(new CoreIdentityError("http://x").message).toContain(
		"could not prove it is your Ryu Core"
	);
});
