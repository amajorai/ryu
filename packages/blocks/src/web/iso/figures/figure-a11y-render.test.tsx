import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatNumberValue } from "@ryu/i18n/format-intl";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The figures' screen-reader text renders from the reader's catalog as whole
// sentences: the description paragraph and the slider value text carry no English.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { WorkflowRunArt } = await import("./workflow-run/art.tsx");
const { CoreEnginesArt } = await import("./core-engines/art.tsx");
const { PassportCabinetArt } = await import("./passport-cabinet/art.tsx");

const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		"One Ryu workflow run, drawn as a marble rolling through {nodeCount} nodes in order: input, prompt, a condition, then one of two branches (tool or webhook), an approval gate and output. The condition takes the tool branch, so the webhook branch fades out as skipped. The marble waits at the approval gate until the run is approved. A pin rises on each node as it finishes: the checkpoint Core writes to disk after every node, which is what lets an interrupted run resume. Every checkpoint is kept; only the latest pin is drawn standing. This is a slowed simulation with an example graph. Arrow keys pick a node to hear its state.":
			"Ein Ryu-Workflowlauf mit {nodeCount} Knoten.",
		"Node {position} of {nodeCount}, {name} ({kind}): {status}. {does}":
			"Knoten {position} von {nodeCount}, {name} ({kind}): {status}. {does}",
		output: "Ausgabe",
		"completed, checkpoint saved": "abgeschlossen, Prüfpunkt gespeichert",
		"Returns the run's result.": "Gibt das Ergebnis des Laufs zurück.",
	},
	ja: {
		"{engineName} loaded, engine {position} of {engineCount}: {role}":
			"{engineName} を読み込み済み、エンジン {position}/{engineCount}：{role}",
		"default · CPU or GPU": "既定 · CPU または GPU",
		"voice (Parakeet + Kokoro)": "音声 (Parakeet + Kokoro)",
		"image (Stable Diffusion, optional)": "画像 (Stable Diffusion、任意)",
		"embeddings (nomic v1.5, 768-dim)": "埋め込み (nomic v1.5、768 次元)",
		"A shelf of cartridges standing for the {engineCount} local chat engines Ryu Core supports (a few are drawn), and beside it a player holding the one engine that is loaded, {defaultEngineName} by default. Core keeps at most one local chat engine loaded: choosing another first takes the loaded one back to its slot, then brings the new one to the player. Engines for {alongsideNames} run alongside the chat engine and are never swapped, so they are not on the shelf. A faint ring on the player pulses once per health check; Core checks every {healthIntervalSeconds} seconds, shown {sweepSpeedup} times faster. Arrow keys choose an engine and Enter loads it.":
			"{engineCount} 個のエンジン、既定は {defaultEngineName}。{alongsideNames} のエンジンはチャットエンジンと並行して動きます。{healthIntervalSeconds} 秒ごと、{sweepSpeedup} 倍速。",
	},
	ar: {
		"Ryu Passport drawn as a cabinet of keys": "Ryu Passport كخزانة مفاتيح",
		"Ryu Passport drawn as a cabinet of keys: each box holds one connection's sign-in, a session of at most {maxStateKib} KiB sealed with its tenant's own key and bound to its box, so a copy moved elsewhere will not open. One key leaves its box and Passport carries it to the site itself; only the fetched page comes back down to the agent's tray, with any echoed credential blacked out, so the agent never holds the key. A health sweep runs hourly and sends a missing or stale session back to needs sign-in. {failureLimit} unknown tokens from one address within {failureWindowSeconds} seconds are refused with {lockoutStatus}, the block doubling up to {maxBlockMinutes} minutes. The motion is a simulation, shown slower than a real fetch; the other keys are decoration.":
			"جلسة بحد أقصى {maxStateKib} كيلوبايت؛ يُرفض {failureLimit} رمزًا خلال {failureWindowSeconds} ثانية بالرمز {lockoutStatus}، حتى {maxBlockMinutes} دقيقة.",
	},
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function renderIn(locale: string, node: ReactNode): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith(locale) ? (CATALOGS[locale] ?? {}) : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

const srText = (container: HTMLElement) =>
	[...container.querySelectorAll(".iso-sr")]
		.map((element) => element.textContent ?? "")
		.join(" ");

test("workflow run: description and value text render in German", async () => {
	const container = await renderIn("de", <WorkflowRunArt />);
	expect(srText(container)).toContain("Ein Ryu-Workflowlauf mit 7 Knoten.");
	expect(srText(container)).not.toContain("One Ryu workflow run");
	const value = container
		.querySelector("[aria-valuetext]")
		?.getAttribute("aria-valuetext");
	expect(value).toBe(
		"Knoten 7 von 7, Ausgabe (Output): abgeschlossen, Prüfpunkt gespeichert. Gibt das Ergebnis des Laufs zurück."
	);
});

test("core engines: value text and alongside list render in Japanese", async () => {
	const container = await renderIn("ja", <CoreEnginesArt />);
	const value = container
		.querySelector("[aria-valuetext]")
		?.getAttribute("aria-valuetext");
	expect(value).toBe(
		"llama.cpp を読み込み済み、エンジン 1/15：既定 · CPU または GPU"
	);
	const description = srText(container);
	expect(description).toContain("音声 (Parakeet + Kokoro)");
	expect(description).toContain("埋め込み (nomic v1.5、768 次元)");
	expect(description).not.toContain("voice (");
	expect(description).not.toMatch(/\band\b/u);
});

test("passport: label and description render in Arabic", async () => {
	const container = await renderIn("ar", <PassportCabinetArt />);
	expect(
		container.querySelector('[aria-label="Ryu Passport كخزانة مفاتيح"]')
	).not.toBeNull();
	const description = srText(container);
	expect(description).not.toContain("cabinet of keys:");
	expect(description).toContain("كيلوبايت");
	expect(description).toContain(`${formatNumberValue("ar", 512)} كيلوبايت`);
});

test("English keeps the source sentences", async () => {
	const container = await renderIn("en", <WorkflowRunArt />);
	expect(srText(container)).toContain(
		"One Ryu workflow run, drawn as a marble rolling through 7 nodes in order"
	);
	expect(
		container.querySelector("[aria-valuetext]")?.getAttribute("aria-valuetext")
	).toBe(
		"Node 7 of 7, output (Output): completed, checkpoint saved. Returns the run's result."
	);
});
