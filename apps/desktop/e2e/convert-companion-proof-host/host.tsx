import { APP_DOWNLOAD_GRANT, ExtensionHost } from "@ryu/app-host/ExtensionHost";
import { capabilitiesFromGrants, type HostServices } from "@ryu/app-host/rpc";
import { htmlCompanionSrcdoc } from "@ryu/app-host/third-party-plugin";
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import manifest from "../../../../apps-store/convert/manifest.json" with {
	type: "json",
};
import appHtml from "../../../../apps-store/convert/ui/dist/index.html?raw";
import { I18nProvider } from "../../../../packages/i18n/src/react.tsx";
import "./host.css";
import proofStyles from "./host.module.css";

interface HostCall {
	input: unknown;
	method: string;
}

interface DownloadAttempt {
	body: number[];
	filename: string;
	href: string;
}

interface ConvertFixture {
	calls: HostCall[];
	downloads: DownloadAttempt[];
	getStored(namespace: string, key: string): string | null;
	toasts: Array<{ input: unknown; method: string }>;
}

declare global {
	interface Window {
		__convertFixture?: ConvertFixture;
	}
}

const STORAGE_PREFIX = "convert-proof:";
const storageKey = (namespace: string | undefined, key: string) =>
	`${namespace ?? "default"}/${key}`;
const calls: HostCall[] = [];
const downloads: DownloadAttempt[] = [];
const toasts: Array<{ input: unknown; method: string }> = [];

function recordCall<Input>(method: string, input: Input): void {
	calls.push({ input: structuredClone(input), method });
}

const services: HostServices = {
	listAgents: async () => [],
	registerRoute: async (claim) => ({ path: claim.path }),
	storageGet: async (input) => {
		recordCall("storage.get", input);
		return localStorage.getItem(
			`${STORAGE_PREFIX}${storageKey(input.namespace, input.key)}`
		);
	},
	storageSet: async (input) => {
		recordCall("storage.set", input);
		localStorage.setItem(
			`${STORAGE_PREFIX}${storageKey(input.namespace, input.key)}`,
			input.value
		);
	},
	uiToastShow: async (input) => {
		recordCall("ui.toast.show", input);
		toasts.push({ input: structuredClone(input), method: "ui.toast.show" });
		return `convert-toast-${toasts.length}`;
	},
};

const fixture: ConvertFixture = {
	calls,
	downloads,
	getStored: (namespace, key) =>
		localStorage.getItem(`${STORAGE_PREFIX}${storageKey(namespace, key)}`),
	toasts,
};
Object.assign(window, { __convertFixture: fixture });

window.addEventListener("message", (event) => {
	const iframe = document.querySelector<HTMLIFrameElement>(
		'iframe[title="Convert"]'
	);
	if (event.source !== iframe?.contentWindow) {
		return;
	}
	const message = z
		.object({
			type: z.literal("convert-download"),
			body: z.array(z.json()),
			filename: z.string(),
			href: z.string(),
		})
		.safeParse(event.data);
	if (message.success) {
		downloads.push({
			body: message.data.body.flatMap((value) => {
				const number = z.number().int().safeParse(value);
				return number.success ? [number.data] : [];
			}),
			filename: message.data.filename,
			href: message.data.href,
		});
	}
});

function ProductHost() {
	const nonce = useMemo(() => crypto.randomUUID(), []);
	const search = new URLSearchParams(window.location.search);
	const view = search.get("view") ?? "convert";
	const preview = search.get("surface") === "preview";
	const srcdoc = useMemo(
		() => htmlCompanionSrcdoc(nonce, appHtml, manifest.id, { view }),
		[nonce, view]
	);
	const approvedGrants = manifest.permission_grants;
	const granted = useMemo(
		() => capabilitiesFromGrants(approvedGrants),
		[approvedGrants]
	);
	if (preview) {
		return (
			<main className={proofStyles["convert-proof-host"]}>
				<p className={proofStyles["convert-proof-banner"]}>
					Standalone Convert preview · no host services
				</p>
				<iframe
					className={proofStyles["convert-proof-frame"]}
					srcDoc={appHtml}
					title="Convert preview"
				/>
			</main>
		);
	}
	return (
		<main className={proofStyles["convert-proof-host"]}>
			<p className={proofStyles["convert-proof-banner"]}>
				Shipped Convert bundle in ExtensionHost · deterministic local storage ·
				no network service
			</p>
			<ExtensionHost
				allowDownloads={approvedGrants.includes(APP_DOWNLOAD_GRANT)}
				allowForms
				granted={granted}
				nonce={nonce}
				services={services}
				srcdoc={srcdoc}
				title="Convert"
			/>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<I18nProvider>
			<ProductHost />
		</I18nProvider>
	);
}
