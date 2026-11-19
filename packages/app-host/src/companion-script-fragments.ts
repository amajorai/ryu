// Shared inline-script fragments for the sandboxed Companion documents.
//
// Both builders, Path A (`thirdPartyPluginSrcdoc`, the evaluated plugin module) and
// Path B (`htmlCompanionSrcdoc`, the self-contained HTML bundle), splice these
// trusted, host-authored fragments into the bootstrap they generate. Keeping one
// copy here is what keeps the two bridges byte-for-byte in step.

import { z } from "zod";

/** Encode host mount data to a JSON literal safe for an inline script. */
export const companionScriptLiteralSchema = z
	.unknown()
	.transform((value) => JSON.stringify(value ?? null))
	.pipe(z.string())
	.transform((serialized) =>
		serialized
			.replace(/</g, "\\u003c")
			.replace(/>/g, "\\u003e")
			.replace(/&/g, "\\u0026")
			.replace(/\u2028/g, "\\u2028")
			.replace(/\u2029/g, "\\u2029")
	);

/** Parse a host value into a script-safe JSON literal. */
export const scriptSafe = companionScriptLiteralSchema.parse;

/** Route a real user's external-link click through the host instead of asking a
 *  sandboxed iframe to create a popup. The host performs its own URL validation. */
export const HOSTED_EXTERNAL_LINKS_SCRIPT = `
document.addEventListener("click", function (event) {
  if (event.defaultPrevented) return;
  var path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
  var link = null;
  for (var i = 0; i < path.length; i++) {
    var candidate = path[i];
    if (candidate && candidate.nodeType === 1 && candidate.tagName === "A") {
      link = candidate;
      break;
    }
  }
  if (!link || (link.getAttribute("target") || "").toLowerCase() !== "_blank") return;
  // Cancel the frame's default popup/navigation even for scripted or unsafe links.
  event.preventDefault();
  if (!event.isTrusted || event.button !== 0) return;
  var destination;
  try { destination = new URL(link.href, document.baseURI); } catch (_) { return; }
  if (destination.protocol !== "https:" && destination.protocol !== "http:") return;
  call("ui.openExternal", [{ href: destination.href }]).catch(function () {});
}, true);
`;

/** Marshal RPC arguments the way the JSON the host forwards does. Structured clone
 *  keeps `undefined` members of plain objects, which a JSON body drops and the host's
 *  JSON contracts reject; class instances (Blob, File, ArrayBuffer) pass unchanged. */
export const RPC_ARGS_SCRIPT = `
function rpcArgs(value) {
  if (Array.isArray(value)) return value.map(rpcArgs);
  if (value === null || typeof value !== "object") return value;
  var prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  var output = {};
  Object.keys(value).forEach(function (key) {
    if (value[key] === undefined) return;
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: rpcArgs(value[key]),
      writable: true
    });
  });
  return output;
}
`;

/** Prefix every line of a generated script fragment (keeps nested output aligned). */
export function indentGeneratedScript(value: string, prefix: string): string {
	return value
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

/** Inline state projection shared by the two sandbox document builders. */
export const COMPANION_THEME_STATE_SCRIPT = `
function applyThemeState(tokens) {
  if (!tokens || typeof tokens !== "object") return;
  var root = document.documentElement;
  var mode = tokens["--ryu-theme-mode"];
  if (mode === "dark" || mode === "light") {
    root.classList.toggle("dark", mode === "dark");
    root.classList.toggle("light", mode === "light");
    root.setAttribute("data-ryu-theme", mode);
  }
  var colorScheme = tokens["--ryu-color-scheme"];
  if (colorScheme === "dark" || colorScheme === "light") {
    root.style.setProperty("color-scheme", colorScheme);
  }
  function setStateAttribute(token, attribute, activeValue) {
    var value = tokens[token];
    if (typeof value !== "string") return;
    if (value === activeValue) root.setAttribute(attribute, activeValue);
    else root.removeAttribute(attribute);
  }
  setStateAttribute("--ryu-pointer-cursor", "data-pointer-cursor", "true");
  setStateAttribute("--ryu-chrome-shadows", "data-chrome-shadows", "off");
  setStateAttribute("--ryu-inverted-backgrounds", "data-inverted-backgrounds", "on");
  setStateAttribute("--ryu-dialog-overlay-mode", "data-dialog-overlay-blur", "off");
  setStateAttribute("--ryu-popup-overlay-mode", "data-popup-overlay-blur", "on");
  setStateAttribute("--ryu-animations", "data-ryu-animations", "off");
  setStateAttribute("--ryu-bg-active", "data-ryu-bg-active", "on");
  setStateAttribute("--ryu-page-bg-active", "data-ryu-page-bg-active", "on");
  setStateAttribute("--ryu-high-contrast", "data-high-contrast", "on");
}`;
