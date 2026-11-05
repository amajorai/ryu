/**
 * English source for the Ryu Island Windows installer strings that
 * electron-builder owns: its `messages.yml` (app running, installing,
 * uninstall prompts) and `assistedMessages.yml` (the install-mode and
 * uninstall-mode pages of the assisted wizard). Windows shows them before
 * Island (and its i18n runtime) is installed.
 *
 * electron-builder translates these for some languages only and writes the
 * English text for every other installer language. For each official catalog
 * locale and each key electron-builder leaves in English,
 * `scripts/sync-island-nsis-languages.mjs` writes the catalog translation into
 * `apps/island/resources/installer-languages.nsh`, which
 * `apps/island/electron-builder.yml` loads through `nsis.include`.
 *
 * - The key is electron-builder's `LangString` name; the value is its English
 *   text in app-builder-lib's `templates/nsis/*.yml`. The sync script's test
 *   fails when they differ.
 * - Placeholders are the NSIS values the installer substitutes:
 *   `{productName}` (`${PRODUCT_NAME}`) and `{lineBreak}` (a line break; the
 *   catalogs fold literal newlines). No ICU plurals or selects.
 * - `&` marks the keyboard accelerator of a radio button label.
 *
 * `tl()` here is an identity marker so `tools/i18n-extract` collects each
 * sentence into the catalogs; nothing in the app imports this module.
 * test-exempt: constant table; `scripts/sync-island-nsis-languages.test.mjs`
 * parses it and checks every key and English value against electron-builder.
 */

const tl = (source: string): string => source;

export const NATIVE_INSTALLER_COPY = {
	win7Required: tl("Windows 7 and above is required"),
	x64WinRequired: tl("64-bit Windows is required"),
	appRunning: tl(
		"{productName} is running.{lineBreak}Click OK to close it.{lineBreak}If it doesn't close, try closing it manually."
	),
	appCannotBeClosed: tl(
		"{productName} cannot be closed. {lineBreak}Please close it manually and click Retry to continue."
	),
	installing: tl("Installing, please wait..."),
	areYouSureToUninstall: tl(
		"Are you sure you want to uninstall {productName}?"
	),
	decompressionFailed: tl(
		"Failed to decompress files. Please try running the installer again."
	),
	uninstallFailed: tl(
		"Failed to uninstall old application files. Please try running the installer again."
	),
	appClosing: tl("Closing running {productName}..."),
	chooseInstallationOptions: tl("Choose Installation Options"),
	chooseUninstallationOptions: tl("Choose Uninstallation Options"),
	whichInstallationShouldBeRemoved: tl("Which installation should be removed?"),
	whoShouldThisApplicationBeInstalledFor: tl(
		"Who should this application be installed for?"
	),
	selectUserMode: tl(
		"Please select whether you wish to make this software available to all users or just yourself"
	),
	whichInstallationRemove: tl(
		"This software is installed both per-machine (all users) and per-user.{lineBreak}Which installation you wish to remove?"
	),
	freshInstallForAll: tl(
		"Fresh install for all users. (will prompt for admin credentials)"
	),
	freshInstallForCurrent: tl("Fresh install for current user only."),
	onlyForMe: tl("Only for &me"),
	forAll: tl("Anyone who uses this computer (&all users)"),
	loginWithAdminAccount: tl(
		"You need to login with an account that is a member of the admin group to continue..."
	),
	perUserInstallExists: tl("There is already a per-user installation."),
	perUserInstall: tl("There is a per-user installation."),
	perMachineInstallExists: tl("There is already a per-machine installation."),
	perMachineInstall: tl("There is a per-machine installation."),
	reinstallUpgrade: tl("Will reinstall/upgrade."),
	uninstall: tl("Will uninstall."),
} as const;

export type NativeInstallerCopyKey = keyof typeof NATIVE_INSTALLER_COPY;
