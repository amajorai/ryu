// Cuts the chat-page native HTTP dev harness's per-navigation module requests.
//
// The harness serves the shipping Layout/ChatPage graph unbundled, so every
// navigation and `page.reload()` fetches the whole graph in one burst. The
// generated app-icon composer alone statically imports 465 PNGs, and in dev
// each import is its own JavaScript module request that only exports the
// image's URL. This replaces those imports with that same URL string in the
// importer, which is exactly what Vite's asset module would export, so the
// graph drops from about 2,750 to about 2,290 requests per load. An `<img>`
// still requests the image itself when it renders. Only relative imports are
// rewritten; aliased or query-suffixed ones keep Vite's handling. Builds are
// untouched.
import path from "node:path";
import type { Plugin } from "vite";

const IMAGE_IMPORT =
	/^import\s+([A-Za-z_$][\w$]*)\s+from\s+["'](\.{1,2}\/[^"'?]+\.(?:png|jpe?g|gif|webp|avif))["'];?$/gm;

function assetUrl(root: string, file: string): string {
	const relative = path.relative(root, file);
	return relative.startsWith("..") || path.isAbsolute(relative)
		? `/@fs${file}`
		: `/${relative.split(path.sep).join("/")}`;
}

export function inlineDevImageImports(root: string): Plugin {
	return {
		name: "ryu-harness:inline-dev-image-imports",
		apply: "serve",
		enforce: "pre",
		transform(code, id) {
			if (id.includes("/node_modules/")) {
				return null;
			}
			const importer = path.dirname(id.split("?")[0] ?? id);
			const next = code.replace(IMAGE_IMPORT, (_statement, name, source) => {
				const url = assetUrl(root, path.resolve(importer, source));
				return `const ${name} = ${JSON.stringify(url)};`;
			});
			return next === code ? null : { code: next, map: null };
		},
	};
}
