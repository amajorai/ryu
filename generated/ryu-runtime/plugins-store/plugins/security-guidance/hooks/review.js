// Turn-hook body for `security-guidance.review`, run in Core's plugin sandbox.
// Injected globals: `ctx` (the turn context) and `host` (the capability bridge:
// host.sideModel / host.storage / host.log / …).
//
// This file is a FRAGMENT, not an ES module: Core splices it into an async IIFE
// (apps/core/src/plugin_host/mod.rs `build_hook_program`) and it `return`s a hook
// directive. That is why a top-level `return` is correct here, and why
// plugins-store/*/*/hooks is excluded from Biome — a module parser rejects it.

const FLAG = "io.ryu.security-guidance";
const toggled = !!(ctx.flags && ctx.flags[FLAG]);
const rev = ctx.transcript.slice().reverse();
const lastUser = rev.find((m) => m.role === "user");
const forced = !!(
	lastUser && lastUser.content.trim().startsWith("/security")
);
if (!toggled && !forced) {
	return { kind: "none" };
}
const lastAssistant = rev.find((m) => m.role === "assistant");
if (
	!lastAssistant ||
	!lastAssistant.content ||
	!lastAssistant.content.trim()
) {
	return { kind: "none" };
}
const code = lastAssistant.content;

// Layer 1 — regex pattern warnings. Ported from the security-guidance
// patterns.py rule set. File-path gating is dropped (a turn hook sees the
// assistant text, not file paths), so the high-signal, API-specific rules are
// kept and the bare eval(/exec( rules that rely on path context are omitted.
const RULES = [
	{
		re: /child_process\.exec|execSync\s*\(/,
		m: "child_process.exec/execSync runs through a shell — command injection. Prefer execFile/spawn with an argument array.",
	},
	{
		re: /new Function\s*\(/,
		m: "new Function() with interpolated input is code injection. Use safe property access or an expression parser.",
	},
	{
		re: /dangerouslySetInnerHTML/,
		m: "dangerouslySetInnerHTML can cause XSS. Sanitize with DOMPurify or avoid raw HTML.",
	},
	{
		re: /document\.write/,
		m: "document.write() enables XSS. Use createElement/appendChild.",
	},
	{
		re: /\.(inner|outer)HTML\s*=/,
		m: "Assigning innerHTML/outerHTML with untrusted content is an XSS sink. Use textContent or a sanitizer.",
	},
	{
		re: /\.insertAdjacentHTML\s*\(/,
		m: "insertAdjacentHTML with untrusted content is an XSS sink. Sanitize first.",
	},
	{
		re: /(?<![a-zA-Z0-9_])pickle\.(loads?|Unpickler)\b/,
		m: "pickle.load on untrusted data allows arbitrary code execution. Prefer JSON or a schema-validated deserializer.",
	},
	{
		re: /\b(cPickle|cloudpickle|dill)\.(load|loads)\s*\(/,
		m: "cPickle/cloudpickle/dill load on untrusted data = arbitrary code execution.",
	},
	{
		re: /\bjoblib\.load\s*\(|\b(?:pd|pandas)\.read_pickle\s*\(/,
		m: "joblib.load / pandas.read_pickle unpickle arbitrary objects. Untrusted input = RCE.",
	},
	{
		re: /\b(?:np|numpy)\.load\s*\([^)\n]{0,200}allow_pickle\s*=\s*True/,
		m: "numpy.load(allow_pickle=True) executes arbitrary code on untrusted files.",
	},
	{
		re: /\bmarshal\.loads?\s*\(/,
		m: "marshal.load on untrusted data is unsafe.",
	},
	{
		re: /\bshelve\.open\s*\(/,
		m: "shelve is pickle-backed — unsafe on untrusted files.",
	},
	{
		re: /\bos\.system\s*\(|from os import system/,
		m: "os.system() runs a shell — command injection. Use subprocess with an argument list, no shell.",
	},
	{
		re: /subprocess\.(?:run|call|Popen|check_output|check_call)\([^\n]*shell\s*=\s*True/,
		m: "subprocess(..., shell=True) is a command-injection risk. Pass an argument list and drop shell=True.",
	},
	{
		re: /exec\.Command\(\s*"(?:sh|bash|\/bin\/sh|\/bin\/bash)"/,
		m: 'exec.Command("sh"/"bash", ...) invokes a shell — command injection in Go.',
	},
	{
		re: /\byaml\.load\s*\((?![^)\n]{0,80}\bSafe)/,
		m: "yaml.load() executes arbitrary Python. Use yaml.safe_load().",
	},
	{
		re: /\byaml\.unsafe_load\s*\(/,
		m: "yaml.unsafe_load() executes arbitrary Python. Use yaml.safe_load().",
	},
	{
		re: /(?:\btorch\.load)\s*\((?![^)\n]{0,200}weights_only\s*=\s*True)/,
		m: "torch.load defaults to weights_only=False (arbitrary code execution). Pass weights_only=True.",
	},
	{
		re: /\b(xml\.etree\.ElementTree|ElementTree|ET)\.(parse|fromstring|XML)\s*\(|\bminidom\.(parse|parseString)\s*\(/,
		m: "Default XML parsers are vulnerable to XXE/billion-laughs. Use defusedxml.",
	},
	{
		re: /\bcrypto\.(createCipher|createDecipher)\b/,
		m: "crypto.createCipher has no IV and is deprecated. Use createCipheriv with a random IV.",
	},
	{
		re: /\bAES\.MODE_ECB\b|\bmodes\.ECB\s*\(|['"]aes-\d+-ecb['"]/,
		m: "AES-ECB leaks plaintext structure. Use an authenticated mode (GCM).",
	},
	{
		re: /\bverify\s*=\s*False\b|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|ssl\._create_unverified_context|check_hostname\s*=\s*False/,
		m: "TLS verification disabled — enables MITM. Do not disable certificate verification.",
	},
];

const hits = [];
for (const r of RULES) {
	if (r.re.test(code)) {
		hits.push("• " + r.m);
	}
}

// Layer 2 — LLM diff review over the code the assistant just produced. Routes
// through the Gateway via host.sideModel; the model is resolved swappably from
// the `security-review-model` preference (never hardcoded).
let review = "";
try {
	const out = await host.sideModel({
		system:
			"You are a security code reviewer. Review only the code in the message for high-confidence security vulnerabilities: injection (SQL/command/code), XSS, SSRF, hardcoded secrets/credentials, IDOR/auth bypass, unsafe deserialization, path traversal, and weak crypto. Report only concrete, exploitable issues with a one-line fix each. If a line has an inline comment justifying why it is safe, treat it as excluded. If you find nothing exploitable, reply with exactly: Looks secure.",
		prompt: "Review this code the assistant just produced:\n\n" + code,
		model_pref_key: "security-review-model",
	});
	if (
		out &&
		out.trim() &&
		!/^looks (secure|good|fine|ok)/i.test(out.trim())
	) {
		review = out.trim();
	}
} catch (e) {
	host.log("security-guidance review failed: " + e);
}

const parts = [];
if (hits.length) {
	parts.push("⚠️ Pattern warnings:\n" + hits.join("\n"));
}
if (review) {
	parts.push("LLM security review:\n" + review);
}
if (!parts.length) {
	return { kind: "none" };
}
return { kind: "note", text: "Security guidance:\n\n" + parts.join("\n\n") };
