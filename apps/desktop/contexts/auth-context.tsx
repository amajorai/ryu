import { createContext, useContext, useState } from "react";
import { clearSessionToken, signOut } from "@/lib/auth-client.ts";
import { useAppStore } from "@/src/store/useAppStore.ts";

interface AuthContextValue {
	handleSignOut: () => Promise<void>;
	isSigningOut: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
	const [isSigningOut, setIsSigningOut] = useState(false);
	const setOidcUser = useAppStore((s) => s.setOidcUser);

	const handleSignOut = async () => {
		if (isSigningOut) {
			return;
		}
		setIsSigningOut(true);
		try {
			await Promise.all([signOut(), clearSessionToken()]);
			setOidcUser(null);
		} finally {
			window.location.reload();
		}
	};

	return (
		<AuthContext.Provider value={{ isSigningOut, handleSignOut }}>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuthContext(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) {
		throw new Error("useAuthContext must be used within AuthProvider");
	}
	return ctx;
}
