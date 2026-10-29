import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
} from "react";

export type AppSurface =
	| "desktop"
	| "web"
	| "extension"
	| "mobile"
	| "telegram";

export const APP_SURFACES: readonly AppSurface[] = [
	"desktop",
	"web",
	"extension",
	"mobile",
	"telegram",
];

/**
 * A host-owned Back control outside the shared tree, such as the Telegram Mini
 * App header button. The shell reports whether in-app history can go back and
 * the host calls `onPress` handlers when its control is used.
 */
export interface HostBackButton {
	onPress: (handler: () => void) => () => void;
	setVisible: (visible: boolean) => void;
}

export interface AppSurfaceCapabilities {
	canManageDesktopLifecycle: boolean;
	canOpenNativeWindows: boolean;
	canUpdateDesktopApp: boolean;
	canUseNativeShell: boolean;
	hostBackButton?: HostBackButton;
	isDesktop: boolean;
	nativeWindowChrome: boolean;
	surface: AppSurface;
}

const DESKTOP_CAPABILITIES = {
	canManageDesktopLifecycle: true,
	canOpenNativeWindows: true,
	canUpdateDesktopApp: true,
	canUseNativeShell: true,
	isDesktop: true,
	nativeWindowChrome: true,
	surface: "desktop",
} satisfies AppSurfaceCapabilities;

const BROWSER_CAPABILITIES = {
	canManageDesktopLifecycle: false,
	canOpenNativeWindows: false,
	canUpdateDesktopApp: false,
	canUseNativeShell: false,
	isDesktop: false,
	nativeWindowChrome: false,
} satisfies Omit<AppSurfaceCapabilities, "surface">;

const CAPABILITIES_BY_SURFACE = {
	desktop: DESKTOP_CAPABILITIES,
	extension: { ...BROWSER_CAPABILITIES, surface: "extension" },
	mobile: { ...BROWSER_CAPABILITIES, surface: "mobile" },
	telegram: { ...BROWSER_CAPABILITIES, surface: "telegram" },
	web: { ...BROWSER_CAPABILITIES, surface: "web" },
} satisfies Record<AppSurface, AppSurfaceCapabilities>;

const AppSurfaceContext =
	createContext<AppSurfaceCapabilities>(DESKTOP_CAPABILITIES);

export function appSurfaceCapabilities(
	surface: AppSurface
): AppSurfaceCapabilities {
	return CAPABILITIES_BY_SURFACE[surface];
}

export function AppSurfaceProvider({
	children,
	hostBackButton,
	surface,
}: {
	children?: ReactNode;
	hostBackButton?: HostBackButton;
	surface: AppSurface;
}) {
	const capabilities = useMemo(
		() =>
			hostBackButton
				? { ...appSurfaceCapabilities(surface), hostBackButton }
				: appSurfaceCapabilities(surface),
		[hostBackButton, surface]
	);

	return (
		<AppSurfaceContext.Provider value={capabilities}>
			{children}
		</AppSurfaceContext.Provider>
	);
}

export function useAppSurface(): AppSurfaceCapabilities {
	return useContext(AppSurfaceContext);
}

/**
 * Mirror the shell's in-app history onto a host Back control when the host
 * provides one. Hosts without one (Desktop, web, extension) are untouched.
 */
export function useHostBackButtonSync(
	canGoBack: boolean,
	goBack: () => void
): void {
	const { hostBackButton } = useAppSurface();

	useEffect(() => {
		if (!hostBackButton) {
			return;
		}
		hostBackButton.setVisible(canGoBack);
	}, [canGoBack, hostBackButton]);

	useEffect(() => {
		if (!hostBackButton) {
			return;
		}
		const unsubscribe = hostBackButton.onPress(goBack);
		return () => {
			unsubscribe();
			hostBackButton.setVisible(false);
		};
	}, [goBack, hostBackButton]);
}

export function NativeDesktopOnly({ children }: { children?: ReactNode }) {
	return useAppSurface().isDesktop ? children : null;
}
