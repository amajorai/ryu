import { useEffect, useState } from "react";
import {
	DEFAULT_STARTUP_REALM,
	readStartupRealm,
	type StartupRealm,
	setStartupRealm,
} from "@/src/lib/product-mode.ts";
import { registerSetting } from "@/src/lib/settings-registry.ts";

export interface StartupRealmResult {
	error: string | null;
	pendingRealm: StartupRealm | null;
	realm: StartupRealm;
	retry: () => void;
	setRealm: (realm: StartupRealm) => void;
}

/** The product realm the Desktop window opens in on its next launch. */
export function useStartupRealm(): StartupRealmResult {
	const [realm, setRealm] = useState<StartupRealm>(readStartupRealm);
	const [pendingRealm, setPendingRealm] = useState<StartupRealm | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const handleChange = () => setRealm(readStartupRealm());
		window.addEventListener("storage", handleChange);
		return () => window.removeEventListener("storage", handleChange);
	}, []);

	function save(nextRealm: StartupRealm) {
		const result = setStartupRealm(nextRealm);
		if (!result.ok) {
			setPendingRealm(nextRealm);
			setError(result.error);
			return;
		}
		setRealm(result.realm);
		setPendingRealm(null);
		setError(null);
	}

	return {
		realm,
		pendingRealm,
		error,
		setRealm: save,
		retry: () => {
			if (pendingRealm !== null) {
				save(pendingRealm);
			}
		},
	};
}

registerSetting({
	category: "general",
	id: "general.on-startup.realm",
	label: "Realm on startup",
	reset: () => setStartupRealm(DEFAULT_STARTUP_REALM),
});
