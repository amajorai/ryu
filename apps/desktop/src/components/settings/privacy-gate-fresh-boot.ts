import { readFileSync } from "node:fs";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { z } from "zod";

// Prospective genuine fresh Bun process/DOM-realm boot, not a browser persistence
// test. The parent's unchanged native Storage bytes are the explicit OS adapter.
// No analytics/crash method or provider implementation is replaced or initialized.
const path = process.argv[2];
if (!path) {
	throw new Error("A saved native Storage snapshot is required");
}
const saved = z
	.record(z.string(), z.string())
	.parse(JSON.parse(readFileSync(path, "utf8")));
if (GlobalRegistrator.isRegistered) {
	throw new Error("Fresh gate worker unexpectedly inherited a DOM");
}
const nativeFetch = globalThis.fetch;
const priorFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const unexpectedHttp: string[] = [];
GlobalRegistrator.register({ url: "http://127.0.0.1/privacy-gate-fresh-boot" });
const priorWindowFetch = Object.getOwnPropertyDescriptor(window, "fetch");
for (const [key, value] of Object.entries(saved)) {
	localStorage.setItem(key, value);
}
const refuseHttp = Object.assign(
	async (input: RequestInfo | URL) => {
		unexpectedHttp.push(String(input));
		throw new Error("Fresh gate boot refuses all provider/network egress");
	},
	{ preconnect: nativeFetch.preconnect }
);
globalThis.fetch = refuseHttp;
window.fetch = refuseHttp;
let result: {
	analytics: boolean;
	crash: boolean;
	storage: Record<string, string>;
	unexpectedHttp: string[];
	ownedDomUnregistered: true;
} | null = null;
try {
	const analytics = await import("../../lib/analytics.ts");
	const crash = await import("../../lib/crash.ts");
	if (analytics.isAnalyticsConfigured() || crash.isCrashReportingConfigured()) {
		throw new Error(
			"A provider was unexpectedly configured in the finite gate boot"
		);
	}
	const storage: Record<string, string> = {};
	for (let index = 0; index < localStorage.length; index += 1) {
		const key = localStorage.key(index);
		if (key === null) {
			throw new Error("Native boot Storage key disappeared");
		}
		const value = localStorage.getItem(key);
		if (value === null) {
			throw new Error("Native boot Storage value disappeared");
		}
		storage[key] = value;
	}
	result = {
		analytics: analytics.isAnalyticsEnabled(),
		crash: crash.isCrashReportingEnabled(),
		storage,
		unexpectedHttp,
		ownedDomUnregistered: true,
	};
} finally {
	if (priorWindowFetch) {
		Object.defineProperty(window, "fetch", priorWindowFetch);
	} else {
		Reflect.deleteProperty(window, "fetch");
	}
	if (priorFetch) {
		Object.defineProperty(globalThis, "fetch", priorFetch);
	} else {
		Reflect.deleteProperty(globalThis, "fetch");
	}
	await GlobalRegistrator.unregister();
}
if (!result || unexpectedHttp.length !== 0 || GlobalRegistrator.isRegistered) {
	throw new Error("Fresh gate boot did not close its owned boundary");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
