// Bun's test runtime loads `.module.css` as an empty object; only Bun's bundler
// implements CSS Modules. Compile each imported module with that bundler so
// tests receive the same class map the apps ship: scoped local names plus any
// `composes: … from global` contract classes.
//
// Bun's bundler is as strict as Turbopack, which `next build` uses: a
// `composes: x from "./file.css"` target must itself be a CSS module, and a
// plain stylesheet fails to compile. Do not relax that here: a test that
// compiles a composes target the production build rejects hides a broken
// deploy. The one deliberate difference is that a root-relative
// `url("/asset.png")` is a public asset path the app serves, so it stays
// external instead of being resolved on disk.
import { plugin } from "bun";

const CSS_MODULE_FILTER = /\.module\.css$/;
const PLAIN_CSS_FILTER = /\.css$/;
const ANY_PATH_FILTER = /.*/;
const ENTRY_PATH = "ryu-css-module-entry";
const ENTRY_NAMESPACE = "ryu-css-module-entry";

async function compileCssModule(stylesheetPath: string): Promise<string> {
	const result = await Bun.build({
		entrypoints: [ENTRY_PATH],
		format: "esm",
		plugins: [
			{
				name: "ryu-css-module-entry",
				setup(build) {
					build.onResolve({ filter: ANY_PATH_FILTER }, (args) => {
						if (args.path === ENTRY_PATH) {
							return { namespace: ENTRY_NAMESPACE, path: ENTRY_PATH };
						}
						if (
							PLAIN_CSS_FILTER.test(args.importer) &&
							args.path.startsWith("/")
						) {
							return { external: true, path: args.path };
						}
					});
					build.onLoad(
						{ filter: ANY_PATH_FILTER, namespace: ENTRY_NAMESPACE },
						() => ({
							contents: `export { default } from ${JSON.stringify(stylesheetPath)};`,
							loader: "js",
						})
					);
				},
			},
		],
		target: "bun",
		throw: false,
	});
	const entry = result.outputs.find((output) => output.kind === "entry-point");
	if (!(result.success && entry)) {
		const reasons = result.logs.map((log) => log.message).join("\n");
		throw new Error(
			`Could not compile CSS module ${stylesheetPath}:\n${reasons}`
		);
	}
	return await entry.text();
}

plugin({
	name: "ryu-blocks-css-modules",
	setup(build) {
		build.onLoad({ filter: CSS_MODULE_FILTER }, async ({ path }) => ({
			contents: await compileCssModule(path),
			loader: "js",
		}));
	},
});
