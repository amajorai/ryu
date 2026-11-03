import type { auth as ryuAuth } from "../index.ts";

// The configuration modules call back into `auth.api` from inside hooks. They
// read it through this registry instead of importing `../index.ts`, so loading
// any one of them never re-enters the module that is still building `auth`.

type RyuAuthApi = (typeof ryuAuth)["api"];

let registeredApi: RyuAuthApi | null = null;

/** Called once by `index.ts` right after `betterAuth(...)` returns. */
export function registerAuthInstance(instance: typeof ryuAuth): void {
	registeredApi = instance.api;
}

/** The live `auth.api`; hooks only run after `index.ts` has registered it. */
export function authApi(): RyuAuthApi {
	if (!registeredApi) {
		throw new Error("auth.api was used before the auth instance was created");
	}
	return registeredApi;
}
