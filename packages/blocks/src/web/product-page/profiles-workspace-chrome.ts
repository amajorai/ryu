import type {
	ProductAvailabilityRow,
	ProductProfile,
} from "./profile-types.ts";

/**
 * The Ryu for Chrome profile (unit workspace), split out of
 * ./profiles-workspace.ts so each file stays small. Its availability matrix
 * lists the places the extension appears in the browser. Only Chrome is
 * listed: no Firefox or Edge store listing exists yet
 * (`EXTENSION_STORE_LISTINGS` in ../download-catalog.tsx).
 */

const DOCS = "apps/fumadocs/content/docs";
const EXTENSION_DOC = `${DOCS}/browser-extension/index.mdx`;
const EXTENSION_ENTRY_DOC = `${DOCS}/browser-extension/popup-and-new-tab.mdx`;
const EXTENSION_MODELS_DOC = `${DOCS}/browser-extension/local-models.mdx`;
const EXTENSION_README = "apps/extension/README.md";
const DESKTOP_CATALOG =
	"packages/blocks/src/web/data/catalog/desktop-devices.tsx";

/** One row per place the extension appears, from the entry-point table. */
function entryPoint(
	platform: string,
	note: string,
	quote: string
): ProductAvailabilityRow {
	return {
		platform,
		state: "early-access",
		note,
		source: { path: EXTENSION_ENTRY_DOC, quote },
	};
}

export const CHROME_PROFILE: ProductProfile = {
	facts: [
		{
			label: "Browser",
			value: "Chrome",
			source: {
				path: EXTENSION_README,
				quote: "A WXT browser extension (Chrome)",
			},
		},
		{
			label: "Connects to",
			value: "Core or Ryu Cloud for chats, agents and settings",
			source: {
				path: EXTENSION_DOC,
				quote:
					"Normal turns, agents, conversations, services, and settings go to Core or Ryu Cloud.",
			},
		},
		{
			label: "In-browser model",
			value: "SmolLM2 135M Instruct, on WebGPU with a WebAssembly fallback",
			source: {
				path: EXTENSION_MODELS_DOC,
				quote: "The default is SmolLM2 135M Instruct",
			},
		},
		{
			label: "Off by default",
			value: "Automatic page saving and the Island page-context bridge",
			source: {
				path: EXTENSION_DOC,
				quote:
					"Automatic page saving and the Island page-context bridge are off by default.",
			},
		},
		{
			label: "Never given to tools",
			value:
				"Arbitrary JavaScript, cookies, hidden credentials and extension storage",
			source: {
				path: EXTENSION_README,
				quote:
					"Browser tools intentionally exclude arbitrary JavaScript/evaluate, cookies, hidden credentials, and extension storage.",
			},
		},
	],
	// Its rows are places in the browser, not platforms it runs on.
	availabilityTitle: "Where it appears",
	availability: [
		{
			platform: "Chrome",
			state: "early-access",
			note: "Not on the Chrome Web Store yet.",
			source: {
				path: DESKTOP_CATALOG,
				quote: "Not from the Chrome Web Store yet.",
			},
		},
		entryPoint(
			"Toolbar popup",
			"Quick Chat and page actions for the active tab.",
			"| Popup | The browser toolbar button |"
		),
		entryPoint(
			"New Tab",
			"Every new tab, with the SmartBar.",
			"| New Tab | Every new tab, with the SmartBar |"
		),
		entryPoint(
			"Address bar",
			"Type “ryu” to search, ask, or run a skill.",
			"| `ryu` omnibox keyword | The address bar |"
		),
		entryPoint(
			"On the page",
			"In-page Copilot and Ask Ryu open on top of the page you are reading.",
			"| In-page Copilot and Ask Ryu | On top of the page you are reading |"
		),
		{
			platform: "Without your Ryu server",
			state: "early-access",
			note: "A private model runs in the browser, with no node doing the inference.",
			source: {
				path: DESKTOP_CATALOG,
				quote: "Yes, with a private model that runs in the browser.",
			},
		},
	],
	compareSlugs: ["ultra", "aside"],
	related: [
		{
			label: "What is prompt injection",
			href: "/blog/what-is-prompt-injection",
			kind: "blog",
		},
	],
	docs: [
		{
			label: "Browser extension",
			path: "/docs/browser-extension",
			description: "How the extension fits together.",
		},
		{
			label: "Popup and New Tab",
			path: "/docs/browser-extension/popup-and-new-tab",
			description: "Every way to start a chat in the browser.",
		},
		{
			label: "Browser-local models",
			path: "/docs/browser-extension/local-models",
			description: "Run a model in the browser itself.",
		},
		{
			label: "Browser tools",
			path: "/docs/browser-extension/browser-tools",
			description: "Typed, permissioned page actions.",
		},
	],
};
