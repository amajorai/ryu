import { afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LanguagePack } from "@ryu/i18n";
import { createAccountLocaleSync } from "@ryu/i18n/account-locale";
import { I18nProvider, useI18n } from "@ryu/i18n/react";
import { act, useEffect, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// The signed-in account, which a test changes to sign the person in.
type Session = { user: { id: string; isAnonymous: boolean } } | null;
let session: Session = null;
const sessionListeners = new Set<() => void>();
function setSession(next: Session): void {
	session = next;
	for (const listener of sessionListeners) {
		listener();
	}
}
const realAuthClient = { ...(await import("@/lib/auth-client.ts")) };
mock.module("@/lib/auth-client.ts", () => ({
	...realAuthClient,
	useSession: () => ({
		data: useSyncExternalStore(
			(listener) => {
				sessionListeners.add(listener);
				return () => sessionListeners.delete(listener);
			},
			() => session
		),
	}),
}));
const { setLanguageMode } = await import("@/src/hooks/useLanguageMode.ts");
const { AccountLocaleSync } = await import("./AccountLocaleSync.tsx");

const german: LanguagePack = {
	schemaVersion: 1,
	id: "coverage/account-locale",
	name: "Deutsch",
	version: "1.0.0",
	locale: "de",
	baseLocale: "en",
	direction: "ltr",
	messages: {},
};

let runtime: ReturnType<typeof useI18n> | null = null;
function Runtime() {
	const i18n = useI18n();
	useEffect(() => {
		runtime = i18n;
	}, [i18n]);
	return null;
}

let root: Root | null = null;
async function mount(
	saved: string[],
	save: ((locale: string) => void) & {
		flushPending?: () => Promise<void>;
	} = (locale) => saved.push(locale)
): Promise<void> {
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root?.render(
			<I18nProvider initialPackId={null} packs={[german]}>
				<Runtime />
				<AccountLocaleSync save={save} />
			</I18nProvider>
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	runtime = null;
	setSession(null);
});

test("restoring a pack or following the OS language never saves", async () => {
	const saved: string[] = [];
	await mount(saved);
	await act(async () => {
		runtime?.selectPack(german.id);
		runtime?.setLocale("fr-FR");
	});
	expect(saved).toEqual([]);
});

test("an explicit choice saves the locale it selects", async () => {
	const saved: string[] = [];
	await mount(saved);
	await act(async () => {
		setLanguageMode("fixed");
		runtime?.selectPack(german.id);
	});
	expect(saved.at(-1)).toBe("de");
	await act(async () => {
		setLanguageMode("fixed");
		runtime?.selectPack(null);
	});
	expect(saved.at(-1)).toBe("en");
});

test("a choice made while signed out is saved once the person signs in", async () => {
	const saved: string[] = [];
	const save = createAccountLocaleSync({
		delayMs: 0,
		isSignedIn: () => Promise.resolve(session !== null),
		saveLocale: (locale) => {
			saved.push(locale);
			return Promise.resolve({});
		},
	});
	await mount(saved, save);
	await act(async () => {
		setLanguageMode("fixed");
		runtime?.selectPack(german.id);
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
	expect(saved).toEqual([]);

	await act(async () => {
		setSession({ user: { id: "user", isAnonymous: false } });
		await new Promise((resolve) => setTimeout(resolve, 5));
	});
	expect(saved).toEqual(["de"]);
});
