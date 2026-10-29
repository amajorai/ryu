import { createRequire } from "node:module";
import type { ReactNode } from "react";

/**
 * Test-only DOM environment for `bun test`. `@ryu/i18n` does not declare
 * happy-dom or react-dom itself yet, so they are resolved from this package
 * first and, failing that, from `@ryu/ui`, which declares both.
 */
const resolvers = [
	createRequire(import.meta.url),
	createRequire(new URL("../../ui/package.json", import.meta.url)),
];

function resolveTestDependency(specifier: string): string {
	for (const resolver of resolvers) {
		try {
			return resolver.resolve(specifier);
		} catch {
			// Try the next workspace package.
		}
	}
	throw new Error(`Cannot resolve test dependency ${specifier}`);
}

interface GlobalRegistratorModule {
	GlobalRegistrator: { isRegistered: boolean; register(): void };
}

/** Register happy-dom globals; import DOM-reading modules after this. */
export async function registerTestDom(): Promise<void> {
	const { GlobalRegistrator }: GlobalRegistratorModule = await import(
		resolveTestDependency("@happy-dom/global-registrator")
	);
	if (!GlobalRegistrator.isRegistered) {
		GlobalRegistrator.register();
	}
	Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
}

export interface TestReactRoot {
	render(node: ReactNode): void;
	unmount(): void;
}

interface ReactDomClientModule {
	createRoot(container: Element | DocumentFragment): TestReactRoot;
}

/** `react-dom/client`, loaded after {@link registerTestDom}. */
export async function loadReactDomClient(): Promise<ReactDomClientModule> {
	return await import(resolveTestDependency("react-dom/client"));
}
