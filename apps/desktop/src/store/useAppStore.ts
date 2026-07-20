import { create } from "zustand";

export interface OidcUserInfo {
	email?: string;
	name?: string;
	picture?: string;
}

const OIDC_USER_KEY = "ryu_oidc_user";

function loadOidcUser(): OidcUserInfo | null {
	try {
		const raw = localStorage.getItem(OIDC_USER_KEY);
		return raw ? (JSON.parse(raw) as OidcUserInfo) : null;
	} catch {
		return null;
	}
}

function saveOidcUser(user: OidcUserInfo | null): void {
	if (user) {
		localStorage.setItem(OIDC_USER_KEY, JSON.stringify(user));
	} else {
		localStorage.removeItem(OIDC_USER_KEY);
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
