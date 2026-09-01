import { useEffect, useState } from "react";
import {
	DEFAULT_STARTUP_REALM,
	readStartupRealm,
	type StartupRealm,
	setStartupRealm,
} from "@/src/lib/product-mode.ts";
import { registerSetting } from "@/src/lib/settings-registry.ts";

/** The product realm the Desktop window opens in on its next launch. */
export function useStartupRealm(): {
	realm: StartupRealm;
	setRealm: (realm: StartupRealm) => void;
} {
	const [realm, setRealm] = useState<StartupRealm>(readStartupRealm);

	useEffect(() => {
		const handleChange = () => setRealm(readStartupRealm());
		window.addEventListener("storage", handleChange);
		return () => window.removeEventListener("storage", handleChange);
	}, []);

	return {
		realm,
		setRealm: (nextRealm) => {
			setStartupRealm(nextRealm);
			setRealm(readStartupRealm());
		},
	};
}

registerSetting({
	category: "general",
	id: "general.on-startup.realm",
	label: "Realm on startup",
	reset: () => setStartupRealm(DEFAULT_STARTUP_REALM),
});
