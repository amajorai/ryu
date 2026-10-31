import {
	type ComponentType,
	lazy,
	type ReactNode,
	Suspense,
	useState,
} from "react";

export interface PreloadableLazy<P extends object> {
	/** Fetch the module now (idempotent). Resolves once it can render without suspending. */
	preload: () => Promise<void>;
	/**
	 * Renders the component, showing `fallback` only while its module is still
	 * loading. An instance mounted after the module has loaded renders it
	 * directly, with no Suspense boundary and no fallback frame.
	 */
	Render: (props: P & { fallback?: ReactNode }) => ReactNode;
}

/**
 * `React.lazy` plus an idle-preload handle, for heavy components that are not
 * part of the first paint. Once the module is loaded (by an earlier render or
 * by `preload()`), new instances render synchronously, so warming the chunk in
 * idle time removes the loading frame entirely. An instance that mounted
 * through the lazy path keeps it for life: switching it to the direct
 * component would change its element type and remount (and reset) it.
 */
export function preloadableLazy<P extends object>(
	load: () => Promise<ComponentType<P>>
): PreloadableLazy<P> {
	let loaded: ComponentType<P> | null = null;
	let pending: Promise<ComponentType<P>> | null = null;
	const fetchComponent = (): Promise<ComponentType<P>> => {
		pending ??= load().then(
			(component) => {
				loaded = component;
				return component;
			},
			(error: unknown) => {
				// Let a later `preload()` retry a chunk that failed to load.
				pending = null;
				throw error;
			}
		);
		return pending;
	};
	// `lazy` erases the generic props; the loader returns exactly ComponentType<P>.
	const LazyComponent = lazy(() =>
		fetchComponent().then((component) => ({ default: component }))
	) as unknown as ComponentType<P>;

	function Render({
		fallback = null,
		...props
	}: P & { fallback?: ReactNode }): ReactNode {
		const [direct] = useState(() => loaded);
		const componentProps = props as unknown as P;
		if (direct) {
			const Loaded = direct;
			return <Loaded {...componentProps} />;
		}
		return (
			<Suspense fallback={fallback}>
				<LazyComponent {...componentProps} />
			</Suspense>
		);
	}

	return {
		preload: () => fetchComponent().then(() => undefined),
		Render,
	};
}
