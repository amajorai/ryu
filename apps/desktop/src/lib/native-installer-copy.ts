/**
 * English source for the Windows NSIS installer's Tauri-specific strings: the
 * wizard text Windows shows before Ryu (and its i18n runtime) is installed.
 *
 * Tauri's NSIS bundler ships these strings for a fixed set of languages. For a
 * catalog locale whose NSIS language Tauri does not translate but NSIS core
 * does (Hindi), `scripts/sync-desktop-nsis-language.mjs` turns this table plus
 * `packages/i18n/locales/<locale>.json` into
 * `apps/desktop/src-tauri/nsis/<Language>.nsh`, which every
 * `tauri*.conf.json` names in `bundle.windows.nsis.customLanguageFiles`. NSIS
 * core supplies that language's standard wizard pages and buttons.
 *
 * - The key is the `LangString` name in Tauri's `languages/English.nsh`
 *   (tauri-cli 2.12.4); the value is that string's English text.
 * - Placeholders are the NSIS values the installer substitutes:
 *   `{productName}` (`${PRODUCTNAME}`), `{version}` (`${VERSION}`),
 *   `{versionKind}` (`$R4`, the translated "older" or "unknown"),
 *   `{error}` (`$0`), `{exitCode}` (`$1`) and `{lineBreak}` (`$\n`; the
 *   catalogs fold literal newlines). No ICU plurals or selects.
 *
 * `tl()` here is an identity marker so `tools/i18n-extract` collects each
 * sentence into the catalogs; nothing in the app imports this module.
 * test-exempt: constant table; `scripts/sync-desktop-nsis-language.test.mjs`
 * parses it and checks every key and placeholder.
 */

const tl = (source: string): string => source;

export const NATIVE_INSTALLER_COPY = {
	addOrReinstall: tl("Add/Reinstall components"),
	alreadyInstalled: tl("Already Installed"),
	alreadyInstalledLong: tl(
		"{productName} {version} is already installed. Select the operation you want to perform and click Next to continue."
	),
	appRunning: tl(
		"{productName} is running! Please close it first then try again."
	),
	appRunningOkKill: tl(
		"{productName} is running!{lineBreak}Click OK to kill it"
	),
	chooseMaintenanceOption: tl("Choose the maintenance option to perform."),
	chooseHowToInstall: tl("Choose how you want to install {productName}."),
	createDesktop: tl("Create desktop shortcut"),
	dontUninstall: tl("Do not uninstall"),
	dontUninstallDowngrade: tl(
		"Do not uninstall (Downgrading without uninstall is disabled for this installer)"
	),
	failedToKillApp: tl(
		"Failed to kill {productName}. Please close it first then try again"
	),
	installingWebview2: tl("Installing WebView2..."),
	newerVersionInstalled: tl(
		"A newer version of {productName} is already installed! It is not recommended that you install an older version. If you really want to install this older version, it's better to uninstall the current version first. Select the operation you want to perform and click Next to continue."
	),
	older: tl("older"),
	olderOrUnknownVersionInstalled: tl(
		"An {versionKind} version of {productName} is installed on your system. It's recommended that you uninstall the current version before installing. Select the operation you want to perform and click Next to continue."
	),
	silentDowngrades: tl(
		"Downgrades are disabled for this installer, can't proceed with the silent installer, please use the graphical interface installer instead.{lineBreak}"
	),
	unableToUninstall: tl("Unable to uninstall!"),
	uninstallApp: tl("Uninstall {productName}"),
	uninstallBeforeInstalling: tl("Uninstall before installing"),
	unknown: tl("unknown"),
	webview2AbortError: tl(
		"Failed to install WebView2! The app can't run without it. Try restarting the installer."
	),
	webview2DownloadError: tl("Error: Downloading WebView2 Failed - {error}"),
	webview2DownloadSuccess: tl("WebView2 bootstrapper downloaded successfully"),
	webview2Downloading: tl("Downloading WebView2 bootstrapper..."),
	webview2InstallError: tl(
		"Error: Installing WebView2 failed with exit code {exitCode}"
	),
	webview2InstallSuccess: tl("WebView2 installed successfully"),
	deleteAppData: tl("Delete the application data"),
} as const;

export type NativeInstallerCopyKey = keyof typeof NATIVE_INSTALLER_COPY;
