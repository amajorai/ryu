// The billing proof's Tauri bridge while the auth client and
// EntitlementProvider load. It answers the sealed `auth-vault` / `license-key`
// slots from this tab's sessionStorage (surviving the spec's reloads) and
// seeds a plaintext vault once, so the first load migrates it into the slot
// and purges it from localStorage exactly as an upgraded install does.
// billing-tab-proof.tsx replaces this bridge after its imports evaluate and
// keeps answering the same slots.
import { answerDesktopSecretSlot } from "./desktop-secret-slots.ts";

const SEEDED_KEY = "billing-tab-proof:vault-seeded";

const billingFixtureAccount = {
	email: "billing@example.test",
	image: null,
	isAnonymous: false,
	name: "Billing fixture",
	token: "billing-tab-proof-token",
	userId: "billing-tab-proof-user",
};

if (!sessionStorage.getItem(SEEDED_KEY)) {
	sessionStorage.setItem(SEEDED_KEY, "true");
	localStorage.setItem("ryu_accounts", JSON.stringify([billingFixtureAccount]));
	localStorage.setItem("ryu_active_user_id", billingFixtureAccount.userId);
	localStorage.setItem("ryu_session_token", billingFixtureAccount.token);
}
localStorage.setItem("ryu:interface-level", "expert");

Object.assign(window, {
	__TAURI_INTERNALS__: {
		invoke: async (command: string, args?: Record<string, unknown>) => {
			const slot = answerDesktopSecretSlot(sessionStorage, command, args);
			return slot.handled ? slot.value : null;
		},
		transformCallback: () => 0,
	},
});
