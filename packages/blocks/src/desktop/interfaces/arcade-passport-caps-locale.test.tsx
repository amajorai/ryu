// The Arcade cabinet's engraved labels (Collect, Spin, Credits, Win, Payout)
// and the Passport's photo captions (Photo, Holder) are catalog words drawn in
// capitals by CSS, so a German reader sees "EINSAMMELN" where English shows
// "COLLECT". The key stays the normal-case word the extractor reads.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { usefulStateFixture } = await import("./game-acts-fixture.ts");
const { buildFloor } = await import("./arcade-model.ts");
const { arcadePalette } = await import("./arcade-palette.ts");
const { SlotCabinet } = await import("./arcade-cabinet.tsx");
const { Meter, Tray } = await import("./arcade-cabinet-tray.tsx");
const { buildPassport } = await import("./passport-model.ts");
const { IdentityPage } = await import("./passport-pages-front.tsx");
const { VisaFace } = await import("./passport-page-face.tsx");

import type { ReactElement } from "react";
import type { Machine } from "./arcade-model.ts";

const GERMAN: Record<string, string> = {
	Collect: "Einsammeln",
	"Collect: no replies waiting": "Einsammeln: keine Antworten offen",
	Credits: "Credits",
	Holder: "Inhaber",
	Payout: "Auszahlung",
	Photo: "Foto",
	Spin: "Drehen",
	Win: "Gewinn",
};

// Japanese has no case, so CSS `uppercase` leaves the catalog word as is.
const JAPANESE: Record<string, string> = {
	Collect: "受け取る",
	Credits: "クレジット",
	Spin: "スピン",
	Win: "当たり",
};

const mounted: (() => void)[] = [];
afterEach(() => {
	registerLiteralCatalogLoader(null);
	for (const dispose of mounted.splice(0)) {
		dispose();
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(locale: string, element: ReactElement) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de")
			? GERMAN
			: requested.startsWith("ja")
				? JAPANESE
				: {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{element}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	mounted.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

/** The element whose own text is `text`, with its class list. */
function labelled(container: HTMLElement, text: string) {
	const match = [...container.querySelectorAll("*")].find(
		(element) =>
			[...element.childNodes].some(
				(node) => node.nodeType === 3 && node.textContent?.trim() === text
			) || element.textContent?.trim() === text
	);
	return {
		found: match !== undefined,
		uppercase: Boolean(
			match?.closest(".uppercase") ?? match?.querySelector(".uppercase")
		),
	};
}

const palette = arcadePalette("light");
const floor = buildFloor(usefulStateFixture(), null);

function machineWith(predicate: (machine: Machine) => boolean): Machine {
	const machine = floor.machines.find(predicate);
	if (!machine) {
		throw new Error("Expected a fixture machine");
	}
	return machine;
}

function cabinet(machine: Machine) {
	return (
		<SlotCabinet
			active={false}
			activeThreadId={null}
			agents={usefulStateFixture().agents}
			blurId="blur"
			composing={false}
			feedback={false}
			machine={machine}
			onCompose={() => undefined}
			onOpen={() => undefined}
			palette={palette}
			reduced
			zoom={1}
		/>
	);
}

test("German cabinet buttons show the translated words in capitals", async () => {
	const container = await mount(
		"de",
		cabinet(machineWith((machine) => machine.jackpots.length > 0))
	);
	for (const word of ["Einsammeln", "Drehen"]) {
		expect(labelled(container, word)).toEqual({
			found: true,
			uppercase: true,
		});
	}
	expect(container.textContent).not.toContain("COLLECT");
	expect(container.textContent).not.toContain("SPIN");
});

test("A long translation widens the Collect button instead of spilling out", async () => {
	const container = await mount(
		"de",
		cabinet(machineWith((machine) => machine.jackpots.length > 0))
	);
	const collect = [...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Einsammeln"
	);
	expect(collect?.className).toContain("min-w-[80px]");
	expect(collect?.className).toContain("whitespace-nowrap");
	expect(collect?.className).not.toContain(" w-[80px]");
});

test("The idle Collect button's spoken label is translated", async () => {
	const idle = machineWith((machine) => machine.jackpots.length === 0);
	const container = await mount("de", cabinet(idle));
	const labels = [...container.querySelectorAll("button")].map((button) =>
		button.getAttribute("aria-label")
	);
	expect(labels).toContain("Einsammeln: keine Antworten offen");
	expect(labels).not.toContain("Collect: no replies waiting");
});

test("Japanese cabinet and meter show the catalog words unchanged", async () => {
	const machine = machineWith(
		(item) => item.jackpots.length > 0 && item.tilt === null
	);
	const container = await mount(
		"ja",
		<>
			{cabinet(machine)}
			<Meter blink={false} machine={machine} palette={palette} zoom={1} />
		</>
	);
	for (const word of ["受け取る", "スピン", "クレジット", "当たり"]) {
		expect(labelled(container, word).found).toBe(true);
	}
	for (const english of ["COLLECT", "SPIN", "CREDIT", "WIN"]) {
		expect(container.textContent).not.toContain(english);
	}
});

test("German meters and the empty payout tray translate their labels", async () => {
	const quiet = machineWith((machine) => machine.tilt === null);
	const container = await mount(
		"de",
		<>
			<Meter blink={false} machine={quiet} palette={palette} zoom={1} />
			<Tray
				activeThreadId={null}
				agents={[]}
				machine={{ ...quiet, jackpots: [] }}
				onOpen={() => undefined}
				palette={palette}
				zoom={1}
			/>
		</>
	);
	for (const word of ["Credits", "Gewinn", "Auszahlung"]) {
		expect(labelled(container, word)).toEqual({
			found: true,
			uppercase: true,
		});
	}
	expect(container.textContent).not.toContain("PAYOUT");
});

test("German passport captions translate Photo and Holder", async () => {
	const passport = buildPassport(usefulStateFixture());
	const page = passport.pages.find(
		(item) => item.kind === "visa" && item.first
	);
	if (page?.kind !== "visa") {
		throw new Error("Expected a first visa page");
	}
	const country =
		passport.countries.find((item) => item.id === page.countryId) ?? null;
	const container = await mount(
		"de",
		<>
			<IdentityPage number={1} passport={passport} side="single" />
			<VisaFace
				activeThreadId={null}
				country={country}
				onOpen={() => undefined}
				page={page}
				status={null}
			/>
		</>
	);
	expect(labelled(container, "FOTO")).toEqual({ found: true, uppercase: true });
	const holder = container.querySelector("svg text");
	expect(holder?.textContent).toBe("Inhaber");
	expect(holder?.getAttribute("class")).toContain("uppercase");
});

test("English keeps the capitalised arcade words through CSS", async () => {
	const container = await mount(
		"en",
		cabinet(machineWith((machine) => machine.jackpots.length > 0))
	);
	expect(labelled(container, "Collect").uppercase).toBe(true);
	expect(labelled(container, "Spin").uppercase).toBe(true);
});
