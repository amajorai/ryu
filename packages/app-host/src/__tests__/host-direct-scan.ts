import { readFileSync } from "node:fs";
import { join } from "node:path";

// Test support for host-direct-guard.test.ts. It reads source TEXT only (no
// import of the host, of zod or of the TypeScript compiler), so it runs in a
// checkout without installed packages. Every reader throws on a shape it does
// not know, so the guard cannot pass on code it did not understand.

const HOST_API = "crates/core/kernel-contracts/schemas/host-api.json";
const APP_HOST_SRC = "packages/app-host/src";
const SERVICE_DIR = "apps/desktop/src/contributions/host";
/** The builders PluginHostPanel.tsx merges into one services object. */
const SERVICE_BUILDERS: Record<string, string> = {
	buildPluginHostAppServices: "PluginHostPanel-services-apps.ts",
	buildPluginHostCoreServices: "PluginHostPanel-services-core.ts",
	buildPluginHostMediaWorkflowServices:
		"PluginHostPanel-services-media-workflows.ts",
	buildPluginHostRequestServices: "PluginHostPanel-services-requests.ts",
	buildPluginHostShellServices: "PluginHostPanel-services-shell.ts",
};
/** Modules whose exports never reach the node, a sidecar or a local service. */
const LOCAL_MODULES: readonly RegExp[] = [
	/^zod$/,
	/^@ryu\/app-host\//,
	/^@ryu\/ui\/components\/glyph\.ts$/,
	/^@\/lib\/tauri-bridge\.ts$/,
	/^@\/src\/store\//,
	/^@\/src\/contributions\/(?:registry|tab-icon-registry)\.ts$/,
	/^@\/src\/hooks\/useFriendlyMode\.ts$/,
	/^\.\/node-response-contracts\.ts$/,
	/^\.\/PluginHostPanel-theme-tokens\.ts$/,
];
/** Context fields a service may use and still count as local. */
const LOCAL_CONTEXT = new Set([
	"approvedGrantList",
	"assistantContextRef",
	"assistantOwner",
	"assistantSurfaceRef",
	"companion",
	"currentTabId",
	"fileAccess",
	"i18n",
	"isActiveTabRef",
	"mediaPermission",
	"meId",
	"onRequestClose",
	"openGateway",
	"openTab",
	"tl",
	"toastHost",
	"updateTabTitle",
	"updateTabsIconWhere",
]);
const NODE_NAMES = new Set(["node", "getActiveNode", "toTarget"]);
const BRIDGE_NAMES = new Set(["pluginHostInvoke", "pluginHostInvokeStream"]);

const BRIDGE_CALL =
	/pluginHostInvoke(?:Stream)?\(\s*toTarget\(node\),\s*companion\.pluginId\s*,/g;
const CASE_LINE = /^\t\tcase "([^"]+)":/;
const DEFAULT_LINE = /^\t\tdefault:/;
const CONTEXT_FIELDS = /\(\{\n([\w\s,]*)\}: PluginHostServicesContext\)/;
const RUST_LITERAL = /^"([^"\\]+)",$/;
const RUST_CALL = /\b([a-z_]+)::([a-z_]+)\(\)/g;
const RENAME = /\s+as\s+/;
const SERVICE_USE = /\bservices\.([A-Za-z_$][\w$]*)/g;
const STREAM_BRANCH =
	/method === "([^"]+)"\) \{([\s\S]*?)(?=\n\t\} else if|\n\t\}\n)/g;
const PARSED_REPLY =
	/return ([A-Za-z_$][\w$]*)(?:\([^()]*\))?\s*\.parse\(\s*await services\./;
const IMPORT =
	/(import|export)\s+(type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s+"([^"]+)";/g;
const HELPER_IMPORT = /from "\.\/allowlist-projection\.ts"/;
const ANY_OBJECT = /z\.object\(/g;
const HELPER_OBJECT = /allowlistRecord\(\s*z\.object\(/g;
const OPEN_SHAPE =
	/z\.(?:any|unknown|custom|record|looseObject)\(|\.(?:passthrough|loose|catchall)\(/;
const RETURN_OPEN = /^\treturn (?:[A-Za-z_$][\w$.]*\([^(){}]*, )?\{$/;
const RETURN_CLOSE = /^\t\}\)?;$/;
const PROPERTY = /^\t\t(?:async )?([A-Za-z_$][\w$]*)\s*[:(,]/;
const SPREAD = /^\t\t\.\.\.([A-Za-z_$][\w$]*)/;
const CONTINUATION = /^\t\t(?:\t|[})\]])/;
const COMMENT_OR_BLANK = /^\s*(?:\/\/.*)?$/;
const LINE_COMMENT = /(^|\s)\/\/.*$/gm;
const STRING = /"(?:[^"\\\n]|\\.)*"/g;
const NAME = /(^|[^.\w$])([A-Za-z_$][\w$]*)/g;
const PANEL_MERGE =
	/\t\treturn \{\n((?:\t\t\t\.\.\.\w+\(context\),\n)+)\t\t\};/;
const PANEL_SPREAD = /\.\.\.(\w+)\(context\)/g;

export interface HostMethod {
	grant: string | null;
	method: string;
}
export interface ServiceProperty {
	/** Names that make the property a candidate; empty for bridge and local. */
	evidence: string[];
	file: string;
	kind: "bridge" | "direct" | "local";
}
export interface Dispatch {
	/** Methods whose reply the dispatcher parses with an allowlist schema. */
	projected: Set<string>;
	/** Service keys each method's arm calls. No entry: no arm at all. */
	services: Map<string, string[]>;
}
export interface DesktopServices {
	properties: Map<string, ServiceProperty>;
	/** Callee of each spread inside a builder's object, with its file. */
	spreads: Map<string, string>;
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n");
}

/** Methods the TypeScript hosts dispatch, with the grant each one needs. */
export function readHostMethods(root: string): HostMethod[] {
	const contract: {
		methods: { grant: string | null; method: string; tsHost: boolean }[];
	} = JSON.parse(read(root, HOST_API));
	return contract.methods
		.filter((row) => row.tsHost)
		.map((row) => ({ grant: row.grant, method: row.method }));
}

function importedNames(source: string, wanted: "import" | "export" | "both") {
	const names = new Map<string, string>();
	for (const match of source.matchAll(IMPORT)) {
		const [, keyword, typeOnly, defaultName, braces, module = ""] = match;
		if (typeOnly || (wanted !== "both" && keyword !== wanted)) {
			continue;
		}
		if (defaultName) {
			names.set(defaultName, module);
		}
		for (const item of (braces ?? "").split(",")) {
			const name = item.trim().split(RENAME).at(-1) ?? "";
			if (name && !item.trim().startsWith("type ")) {
				names.set(name, module);
			}
		}
	}
	return names;
}

/** True when every object schema of the module is built by allowlistRecord. */
function isAllowlistModule(source: string): boolean {
	const objects = source.match(ANY_OBJECT)?.length ?? 0;
	const wrapped = source.match(HELPER_OBJECT)?.length ?? 0;
	return (
		HELPER_IMPORT.test(source) &&
		objects > 0 &&
		objects === wrapped &&
		!OPEN_SHAPE.test(source)
	);
}

function allowlistSchemaNames(root: string, rpc: string): Set<string> {
	const verdicts = new Map<string, boolean>();
	const names = new Set<string>();
	for (const [name, module] of importedNames(rpc, "import")) {
		if (!module.startsWith("./")) {
			continue;
		}
		if (!verdicts.has(module)) {
			const source = read(root, `${APP_HOST_SRC}/${module.slice(2)}`);
			verdicts.set(module, isAllowlistModule(source));
		}
		if (verdicts.get(module)) {
			names.add(name);
		}
	}
	return names;
}

function serviceKeys(text: string): string[] {
	const keys = [...text.matchAll(SERVICE_USE)].map((use) => use[1] ?? "");
	return [...new Set(keys)];
}

/** The join from a host method to the service keys its dispatcher arm calls. */
export function readDispatch(root: string): Dispatch {
	const rpc = read(root, `${APP_HOST_SRC}/rpc.ts`);
	const start = rpc.indexOf("\n\tswitch (method) {\n");
	const end = rpc.indexOf("\n\t}\n", start);
	if (start < 0 || end < 0 || rpc.indexOf("switch (method)", start + 20) >= 0) {
		throw new Error("rpc.ts: expected exactly one switch (method) block");
	}
	const allowlisted = allowlistSchemaNames(root, rpc);
	const services = new Map<string, string[]>();
	const projected = new Set<string>();
	let labels: string[] = [];
	let body: string[] = [];
	const flush = () => {
		const text = body.join("\n");
		const schema = PARSED_REPLY.exec(text)?.[1];
		for (const label of labels) {
			services.set(label, serviceKeys(text));
			if (schema && allowlisted.has(schema)) {
				projected.add(label);
			}
		}
		labels = [];
		body = [];
	};
	for (const line of rpc.slice(start, end).split("\n")) {
		if (DEFAULT_LINE.test(line)) {
			break;
		}
		const label = CASE_LINE.exec(line)?.[1];
		if (label && body.length > 0) {
			flush();
		}
		if (label) {
			labels.push(label);
		} else if (labels.length > 0) {
			body.push(line);
		}
	}
	flush();
	const streaming = read(root, `${APP_HOST_SRC}/streaming-rpc.ts`);
	for (const [, method = "", branch = ""] of streaming.matchAll(
		STREAM_BRANCH
	)) {
		services.set(method, serviceKeys(branch));
	}
	return { projected, services };
}

/** Imported names and context fields, each with where it comes from. */
function namesInScope(source: string): Map<string, string> {
	const names = importedNames(source, "import");
	const fields = CONTEXT_FIELDS.exec(source)?.[1] ?? "";
	for (const field of fields.split(",")) {
		const name = field.trim();
		if (name && !LOCAL_CONTEXT.has(name)) {
			names.set(name, "context");
		}
	}
	return names;
}

function classify(body: string, imports: Map<string, string>): ServiceProperty {
	const code = body.replace(LINE_COMMENT, "$1").replace(STRING, '""');
	const used = [...code.matchAll(NAME)].map((match) => match[2] ?? "");
	const foreign = new Set<string>();
	for (const name of used) {
		const module = imports.get(name);
		const local = !module || LOCAL_MODULES.some((rule) => rule.test(module));
		if (!(local || BRIDGE_NAMES.has(name) || NODE_NAMES.has(name))) {
			foreign.add(name);
		}
	}
	const count = (name: string) => used.filter((it) => it === name).length;
	const bridged = code.match(BRIDGE_CALL)?.length ?? 0;
	const nodeUses = count("node") + count("getActiveNode");
	const invokes = used.filter((name) => BRIDGE_NAMES.has(name)).length;
	if (foreign.size + nodeUses + invokes + count("toTarget") === 0) {
		return { evidence: [], file: "", kind: "local" };
	}
	const onlyBridge =
		foreign.size === 0 &&
		bridged > 0 &&
		bridged === invokes &&
		bridged === nodeUses &&
		bridged === count("toTarget");
	if (onlyBridge) {
		return { evidence: [], file: "", kind: "bridge" };
	}
	const evidence = [...foreign].sort();
	if (nodeUses > bridged) {
		evidence.unshift("node");
	}
	return { evidence, file: "", kind: "direct" };
}

function scanBuilder(file: string, source: string, into: DesktopServices) {
	const lines = source.split("\n");
	const opens = lines.flatMap((line, at) =>
		RETURN_OPEN.test(line) ? [at] : []
	);
	const open = opens.length === 1 ? (opens[0] ?? -1) : -1;
	const close = lines.findIndex(
		(line, at) => at > open && RETURN_CLOSE.test(line)
	);
	if (open < 0 || close < 0) {
		throw new Error(`${file}: expected one returned services object`);
	}
	const imports = namesInScope(source);
	let key = "";
	let body: string[] = [];
	const flush = () => {
		if (key) {
			const property = classify(body.join("\n"), imports);
			into.properties.set(key, { ...property, file });
		}
		key = "";
		body = [];
	};
	for (const line of lines.slice(open + 1, close)) {
		const property = PROPERTY.exec(line)?.[1];
		const spread = SPREAD.exec(line)?.[1];
		if (property || spread) {
			flush();
		}
		if (property) {
			if (into.properties.has(property)) {
				throw new Error(`${file}: service ${property} is defined twice`);
			}
			key = property;
			body = [line.slice(line.indexOf(property) + property.length)];
		} else if (spread) {
			into.spreads.set(spread, file);
		} else if (CONTINUATION.test(line) || COMMENT_OR_BLANK.test(line)) {
			body.push(line);
		} else {
			throw new Error(`${file}: cannot read the line ${JSON.stringify(line)}`);
		}
	}
	flush();
}

/** One builder's source text, classified. The guard's own test feeds this. */
export function scanServiceSource(file: string, source: string) {
	const result: DesktopServices = { properties: new Map(), spreads: new Map() };
	scanBuilder(file, source, result);
	return result;
}

/** Every service the desktop panel serves, classified by how it is served. */
export function readDesktopServices(root: string): DesktopServices {
	const panel = read(root, `${SERVICE_DIR}/PluginHostPanel.tsx`);
	const merge = PANEL_MERGE.exec(panel)?.[1] ?? "";
	const merged = [...merge.matchAll(PANEL_SPREAD)].map(
		(match) => match[1] ?? ""
	);
	const known = Object.keys(SERVICE_BUILDERS);
	if (merged.sort().join() !== known.sort().join()) {
		throw new Error(
			`PluginHostPanel.tsx merges [${merged.join()}], the guard reads [${known.join()}]`
		);
	}
	const result: DesktopServices = { properties: new Map(), spreads: new Map() };
	for (const file of Object.values(SERVICE_BUILDERS)) {
		scanBuilder(file, read(root, `${SERVICE_DIR}/${file}`), result);
	}
	return result;
}

function arrayLiterals(file: string, source: string, fn: string): string[] {
	const head = source.indexOf(`fn ${fn}() -> Vec<String> {`);
	const open = source.indexOf("\n    [\n", head);
	const close = source.indexOf("\n    ]\n", open);
	if (head < 0 || open < 0 || close < 0) {
		throw new Error(`${file}: cannot find the array of fn ${fn}`);
	}
	const grants: string[] = [];
	for (const raw of source.slice(open + 7, close).split("\n")) {
		const line = raw.trim();
		const literal = RUST_LITERAL.exec(line)?.[1];
		if (literal) {
			grants.push(literal);
		} else if (!(line === "" || line.startsWith("//"))) {
			throw new Error(
				`${file}: fn ${fn} holds a line the reader does not know: ${line}`
			);
		}
	}
	return grants;
}

/**
 * The Gateway's built-in default grant allowlist, read from the Rust source.
 * Knows both layouts: the array inside `default_grant_allowlist` itself, and a
 * body that joins `<module>::<function>()` calls, each an array in `<module>.rs`.
 */
export function readRustDefaultAllowlist(root: string): string[] {
	const dir = "apps/gateway/src/governance";
	const mod = read(root, `${dir}/mod.rs`);
	const head = mod.indexOf("fn default_grant_allowlist() -> Vec<String> {");
	const body = mod.slice(head, mod.indexOf("\n}\n", head));
	if (head < 0) {
		throw new Error("mod.rs: fn default_grant_allowlist not found");
	}
	const calls = [...body.matchAll(RUST_CALL)];
	if (calls.length === 0) {
		return arrayLiterals("mod.rs", mod, "default_grant_allowlist");
	}
	return calls.flatMap(([, module = "", fn = ""]) =>
		arrayLiterals(`${module}.rs`, read(root, `${dir}/${module}.rs`), fn)
	);
}

export interface Judgement {
	/**
	 * covered: Core bridge, local, or an arm that calls no service.
	 * projected: the dispatcher parses the reply with an allowlist schema.
	 * direct: reaches the node or another service without the Core bridge.
	 * unseen: no arm, or a service key no builder writes out.
	 */
	state: "covered" | "direct" | "projected" | "unseen";
	why: string;
}

function judge(
	method: string,
	dispatch: Dispatch,
	desktop: DesktopServices
): Judgement {
	const keys = dispatch.services.get(method);
	if (!keys) {
		return { state: "unseen", why: "no dispatcher arm" };
	}
	if (dispatch.projected.has(method)) {
		return { state: "projected", why: "allowlist schema in the dispatcher" };
	}
	const direct = keys.flatMap((key) => {
		const property = desktop.properties.get(key);
		return property?.kind === "direct"
			? [`${key} in ${property.file} uses ${property.evidence.join(", ")}`]
			: [];
	});
	if (direct.length > 0) {
		return { state: "direct", why: direct.join("; ") };
	}
	const unseen = keys.filter((key) => !desktop.properties.has(key));
	if (unseen.length > 0) {
		return {
			state: "unseen",
			why: `${unseen.join(", ")} is not written in a builder`,
		};
	}
	return { state: "covered", why: "" };
}

/**
 * How the desktop panel serves each host method that any app can call: a
 * method with no grant, or with a grant on `allowlist`.
 */
export function judgeOpenMethods(
	root: string,
	allowlist: readonly string[]
): Map<string, Judgement> {
	const allowed = new Set(allowlist);
	const dispatch = readDispatch(root);
	const desktop = readDesktopServices(root);
	const judged = new Map<string, Judgement>();
	for (const { grant, method } of readHostMethods(root)) {
		if (grant === null || allowed.has(grant)) {
			const verdict = judge(method, dispatch, desktop);
			judged.set(method, { ...verdict, why: `grant ${grant}: ${verdict.why}` });
		}
	}
	return judged;
}
