import { z } from "zod";
import { create } from "zustand";
import { sealedLocalStorage } from "@/src/lib/content-seal.ts";

export interface OidcUserInfo {
	email?: string;
	name?: string;
	picture?: string;
}

// The signed-in user's email, name and avatar are PII: the value is sealed at
// rest through the sealed localStorage facade (hydrated before first render).
const OIDC_USER_KEY = "ryu_oidc_user";

function loadOidcUser(): OidcUserInfo | null {
	try {
		const raw = sealedLocalStorage.getItem(OIDC_USER_KEY);
		return raw
			? z
					.object({
						email: z.string().optional(),
						name: z.string().optional(),
						picture: z.string().optional(),
					})
					.parse(JSON.parse(raw))
			: null;
	} catch {
		return null;
	}
}

function saveOidcUser(user: OidcUserInfo | null): void {
	if (user) {
		sealedLocalStorage.setItem(OIDC_USER_KEY, JSON.stringify(user));
	} else {
		sealedLocalStorage.removeItem(OIDC_USER_KEY);
	}
}

interface AppState {
	coreStatus: "starting" | "running" | "stopped";
	isAuthenticated: boolean;
	oidcUser: OidcUserInfo | null;
	pendingAuthToken: string | null;
	setCoreStatus: (status: AppState["coreStatus"]) => void;
	setIsAuthenticated: (value: boolean) => void;
	setOidcUser: (user: OidcUserInfo | null) => void;
	setPendingAuthToken: (token: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
	coreStatus: "starting",
	setCoreStatus: (status) => set({ coreStatus: status }),
	pendingAuthToken: null,
	setPendingAuthToken: (token) => set({ pendingAuthToken: token }),
	isAuthenticated: false,
	setIsAuthenticated: (value) => set({ isAuthenticated: value }),
	oidcUser: loadOidcUser(),
	setOidcUser: (user) => {
		saveOidcUser(user);
		set({ oidcUser: user });
	},
}));

// This module can be evaluated before the sealed values are hydrated; pick the
// stored user up once they are.
sealedLocalStorage
	.hydrate()
	.then(() => {
		if (useAppStore.getState().oidcUser === null) {
			const stored = loadOidcUser();
			if (stored) {
				useAppStore.setState({ oidcUser: stored });
			}
		}
	})
	.catch(() => undefined);
