import { basename } from "node:path";

// Committed dotenv files that hold only public build-time values. Matched by
// full path, so a same-named file elsewhere still needs review.
const PUBLIC_DOTENV_PATHS = new Set([
	// `vite build --mode playground`: VITE_* public URLs and empty analytics keys.
	"apps/webapp/.env.playground",
]);

// Kept dependency-free on purpose: the public hub mirrors this file with
// bundle-artifact-gate.ts so the Desktop build can run its bundle gate there,
// without publishing the rest of the Ryu Watch scanner.
export function unsafeChangedPath(path: string): string | undefined {
	const file = basename(path);
	if (
		/^\.env(?:\.|$)/.test(file) &&
		!/^\.env\.(?:example|sample|template)$/.test(file) &&
		!PUBLIC_DOTENV_PATHS.has(path)
	) {
		return "dotenv material";
	}
	if (/\.(?:js|mjs|cjs|css|wasm)\.map$/i.test(file)) {
		return "generated source map";
	}
	if (
		/\.(?:p12|pfx|key)$/i.test(file) ||
		/^id_(?:rsa|ed25519|ecdsa)$/.test(file)
	) {
		return "private key material";
	}
	return undefined;
}
