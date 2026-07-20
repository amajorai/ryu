// apps/desktop/src/lib/build-profile.ts
//
// Whether this desktop process is the *dev variant* (the "Ryu Dev" build that runs
// alongside a release install with its own data dir, Core port, and bundle
// identity). Two independent signals, either of which flips the badge to "Dev":
//
//   1. The product name — the packaged dev variant sets `productName: "Ryu Dev"`
//      (tauri.dev.conf.json), so `@tauri-apps/api/app` getName() === "Ryu Dev".
//      This is verifiable purely from the frontend, no Rust round-trip.
//   2. The Rust `get_build_profile` command — covers the local `RYU_PROFILE=dev`
//      case, where the product name is still "Ryu" but the backend is the dev Core
//      on the shifted port. Fail-safe: any error ⇒ not dev.
//
// A plain release build (no dev feature, unset RYU_PROFILE) returns `dev: false`
// from both, so the badge stays hidden — release behaviour is unchanged.

import { useEffect, useState } from "react";

interface BuildProfile {
	dev: boolean;
}

const DEV_PRODUCT_NAME = "Ryu Dev";

async function resolveDev(): Promise<boolean> {
	const [name, rust] = await Promise.all([
		import("@tauri-apps/api/app").then((m) => m.getName()).catch(() => null),
		import("@tauri-apps/api/core")
			.then((m) => m.invoke<{ dev: boolean }>("get_build_profile"))
			.catch(() => null),
	]);
	return name === DEV_PRODUCT_NAME || rust?.dev === true;
}

/** Reactive build profile. `dev` is `false` until resolved (safe default). */
export function useBuildProfile(): BuildProfile {
	const [dev, setDev] = useState(false);

	useEffect(() => {
		let active = true;
		resolveDev()
			.then((value) => {
				if (active) {
					setDev(value);
				}
			})
			.catch(() => undefined);
		return () => {
			active = false;
		};
	}, []);

	return { dev };
}
