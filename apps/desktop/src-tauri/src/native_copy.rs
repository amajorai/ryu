//! Localized copy for the native shell: tray labels, the quit and app-update
//! confirmations, and the macOS application menu.
//!
//! Rust carries no catalog. The webview translates every label with the UI
//! language and hands the finished strings over through [`set_native_copy`]
//! (see `apps/desktop/src/lib/native-copy.ts`). Until it does (cold start, a
//! quit before the webview registered, a crashed renderer) the English
//! literals below are used, so nothing is ever blank.
//!
//! Counted sentences arrive as one template per CLDR plural category plus the
//! category of every count below 200, both computed by `Intl.PluralRules` in
//! the webview, so Rust picks the right form without plural rules of its own.

use std::collections::HashMap;
use std::sync::RwLock;

use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// Stable label ids shared with the webview (`NATIVE_SHELL_COPY_IDS`).
pub(crate) mod ids {
    pub const TRAY_SHOW: &str = "tray.show";
    pub const TRAY_COMPANION: &str = "tray.companion";
    pub const TRAY_CAPTURE_PAUSE: &str = "tray.capturePause";
    pub const TRAY_CAPTURE_RESUME: &str = "tray.captureResume";
    pub const TRAY_TIMELINE: &str = "tray.timeline";
    pub const TRAY_PALETTE: &str = "tray.palette";
    pub const TRAY_SWITCH_INTERFACE: &str = "tray.switchInterface";
    pub const TRAY_DEFAULT_INTERFACE: &str = "tray.defaultInterface";
    pub const TRAY_QUIT: &str = "tray.quit";
    pub const QUIT_TITLE: &str = "quit.title";
    pub const QUIT_CONFIRM: &str = "quit.confirm";
    pub const QUIT_CANCEL: &str = "quit.cancel";
    /// Plural base: the stored ids are `quit.message.<category>`.
    pub const QUIT_MESSAGE: &str = "quit.message";
    pub const UPDATE_TITLE: &str = "update.title";
    pub const UPDATE_CONFIRM: &str = "update.confirm";
    pub const UPDATE_CANCEL: &str = "update.cancel";
    /// Plural base: the stored ids are `update.messageActive.<category>`.
    pub const UPDATE_MESSAGE_ACTIVE: &str = "update.messageActive";
    pub const UPDATE_MESSAGE_IDLE: &str = "update.messageIdle";
    pub const MENU_ABOUT: &str = "menu.about";
    pub const MENU_SERVICES: &str = "menu.services";
    pub const MENU_HIDE: &str = "menu.hide";
    pub const MENU_HIDE_OTHERS: &str = "menu.hideOthers";
    pub const MENU_SHOW_ALL: &str = "menu.showAll";
    pub const MENU_QUIT: &str = "menu.quit";
    pub const MENU_FILE: &str = "menu.file";
    pub const MENU_CLOSE_WINDOW: &str = "menu.closeWindow";
    pub const MENU_EDIT: &str = "menu.edit";
    pub const MENU_UNDO: &str = "menu.undo";
    pub const MENU_REDO: &str = "menu.redo";
    pub const MENU_CUT: &str = "menu.cut";
    pub const MENU_COPY: &str = "menu.copy";
    pub const MENU_PASTE: &str = "menu.paste";
    pub const MENU_SELECT_ALL: &str = "menu.selectAll";
    pub const MENU_VIEW: &str = "menu.view";
    pub const MENU_FULLSCREEN: &str = "menu.fullscreen";
    pub const MENU_WINDOW: &str = "menu.window";
    pub const MENU_MINIMIZE: &str = "menu.minimize";
    pub const MENU_ZOOM: &str = "menu.zoom";
    pub const MENU_HELP: &str = "menu.help";
}

/// English fallback for every plain label. `{app}` is the product name.
const ENGLISH: &[(&str, &str)] = &[
    (ids::TRAY_SHOW, "Show Ryu"),
    (ids::TRAY_COMPANION, "Show/Hide Companion"),
    (ids::TRAY_CAPTURE_PAUSE, "Pause Capture"),
    (ids::TRAY_CAPTURE_RESUME, "Resume Capture"),
    (ids::TRAY_TIMELINE, "Open Timeline"),
    (ids::TRAY_PALETTE, "Search Everything…"),
    (ids::TRAY_SWITCH_INTERFACE, "Switch Interface…"),
    (ids::TRAY_DEFAULT_INTERFACE, "Back to Default Interface"),
    (ids::TRAY_QUIT, "Quit"),
    (ids::QUIT_TITLE, "Quit Ryu?"),
    (ids::QUIT_CONFIRM, "Quit anyway"),
    (ids::QUIT_CANCEL, "Keep working"),
    (ids::UPDATE_TITLE, "Install update and restart Ryu?"),
    (ids::UPDATE_CONFIRM, "Update and restart"),
    (ids::UPDATE_CANCEL, "Keep working"),
    (ids::UPDATE_MESSAGE_IDLE, "Installing this app update restarts Ryu. Any local chats, tools, and workflows running when it restarts will stop. Finish your work first or update now. Remote nodes continue running."),
    (ids::MENU_ABOUT, "About {app}"),
    (ids::MENU_SERVICES, "Services"),
    (ids::MENU_HIDE, "Hide {app}"),
    (ids::MENU_HIDE_OTHERS, "Hide Others"),
    (ids::MENU_SHOW_ALL, "Show All"),
    (ids::MENU_QUIT, "Quit {app}"),
    (ids::MENU_FILE, "File"),
    (ids::MENU_CLOSE_WINDOW, "Close Window"),
    (ids::MENU_EDIT, "Edit"),
    (ids::MENU_UNDO, "Undo"),
    (ids::MENU_REDO, "Redo"),
    (ids::MENU_CUT, "Cut"),
    (ids::MENU_COPY, "Copy"),
    (ids::MENU_PASTE, "Paste"),
    (ids::MENU_SELECT_ALL, "Select All"),
    (ids::MENU_VIEW, "View"),
    (ids::MENU_FULLSCREEN, "Toggle Full Screen"),
    (ids::MENU_WINDOW, "Window"),
    (ids::MENU_MINIMIZE, "Minimize"),
    (ids::MENU_ZOOM, "Zoom"),
    (ids::MENU_HELP, "Help"),
];

/// English plural fallback: (base id, one, other). `{count}` is the count.
const ENGLISH_PLURALS: &[(&str, &str, &str)] = &[
    (
        ids::QUIT_MESSAGE,
        "{count} local task is still running. Quitting Ryu will stop it. Keep the app open until it finishes, or quit anyway.",
        "{count} local tasks are still running. Quitting Ryu will stop them. Keep the app open until they finish, or quit anyway.",
    ),
    (
        ids::UPDATE_MESSAGE_ACTIVE,
        "{count} local task is running. Installing this app update restarts Ryu and stops local chats, tools, and workflows, including work waiting for approval. Finish your work first or update now. Remote nodes continue running.",
        "{count} local tasks are running. Installing this app update restarts Ryu and stops local chats, tools, and workflows, including work waiting for approval. Finish your work first or update now. Remote nodes continue running.",
    ),
];

const PLURAL_CATEGORIES: &[&str] = &["zero", "one", "two", "few", "many", "other"];
/// `generate_handler!` commands are not capability-gated, so bound the payload.
const MAX_LABELS: usize = 128;
const MAX_LABEL_BYTES: usize = 2048;
const MAX_CATEGORY_TABLE: usize = 200;

/// What the webview sends: finished labels, the plural category of every
/// count below 200, and the locale's ten digits (`0`-`9`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeShellCopy {
    #[serde(default)]
    labels: HashMap<String, String>,
    #[serde(default)]
    plural_categories: Vec<String>,
    #[serde(default)]
    digits: Option<String>,
    /// The locale the webview shows; kept for WebView2's next launch.
    #[serde(default)]
    locale: Option<String>,
    /// `"fixed"` (explicit choice) or `"auto"`; macOS keeps a fixed one.
    #[serde(default)]
    language_mode: Option<String>,
}

#[derive(Debug, Default)]
struct Store {
    labels: HashMap<String, String>,
    categories: Vec<&'static str>,
    digits: Option<[char; 10]>,
}

static STORE: RwLock<Option<Store>> = RwLock::new(None);

fn english(id: &str) -> Option<&'static str> {
    ENGLISH
        .iter()
        .find(|(key, _)| *key == id)
        .map(|(_, text)| *text)
}

fn plural_base(id: &str) -> Option<&'static str> {
    let (base, category) = id.rsplit_once('.')?;
    PLURAL_CATEGORIES.contains(&category).then_some(())?;
    ENGLISH_PLURALS
        .iter()
        .find(|(key, ..)| *key == base)
        .map(|(key, ..)| *key)
}

fn category(value: &str) -> Option<&'static str> {
    PLURAL_CATEGORIES
        .iter()
        .copied()
        .find(|known| *known == value)
}

/// Validate and normalise a payload. Unknown ids and oversize or blank labels
/// are dropped one by one (English stays for them); a malformed category
/// table or digit set is ignored as a whole.
fn sanitize(copy: NativeShellCopy) -> Result<Store, String> {
    if copy.labels.len() > MAX_LABELS || copy.plural_categories.len() > MAX_CATEGORY_TABLE {
        return Err("native copy payload is too large".to_owned());
    }
    let labels = copy
        .labels
        .into_iter()
        .filter(|(id, _)| english(id).is_some() || plural_base(id).is_some())
        .filter_map(|(id, text)| {
            let text: String = text
                .chars()
                .filter(|c| !c.is_control() || *c == '\n')
                .collect();
            let text = text.trim().to_owned();
            (!text.is_empty() && text.len() <= MAX_LABEL_BYTES).then_some((id, text))
        })
        .collect();
    let categories: Option<Vec<_>> = copy.plural_categories.iter().map(|c| category(c)).collect();
    let digits = copy.digits.and_then(|digits| {
        let chars: Vec<char> = digits.chars().collect();
        let valid = chars.len() == 10 && chars.iter().all(|c| c.is_numeric());
        valid.then(|| std::array::from_fn(|index| chars[index]))
    });
    Ok(Store {
        labels,
        categories: categories.unwrap_or_default(),
        digits,
    })
}

fn read<T>(f: impl FnOnce(Option<&Store>) -> T) -> T {
    match STORE.read() {
        Ok(guard) => f(guard.as_ref()),
        Err(poisoned) => f(poisoned.into_inner().as_ref()),
    }
}

fn replace_store(store: Store) {
    match STORE.write() {
        Ok(mut guard) => *guard = Some(store),
        Err(poisoned) => *poisoned.into_inner() = Some(store),
    }
}

/// The localized label for `id`, else its English literal.
pub(crate) fn label(id: &str) -> String {
    read(|store| store.and_then(|store| store.labels.get(id).cloned()))
        .or_else(|| english(id).map(str::to_owned))
        .unwrap_or_else(|| id.to_owned())
}

fn english_plural(base: &str, count: u64) -> String {
    ENGLISH_PLURALS
        .iter()
        .find(|(key, ..)| *key == base)
        .map(|(_, one, other)| if count == 1 { *one } else { *other })
        .unwrap_or_default()
        .to_owned()
}

fn localized_digits(count: u64, digits: Option<&[char; 10]>) -> String {
    let ascii = count.to_string();
    match digits {
        Some(digits) => ascii
            .bytes()
            .map(|byte| digits[usize::from(byte - b'0')])
            .collect(),
        None => ascii,
    }
}

/// The counted sentence under plural `base` for `count`, in the UI language.
pub(crate) fn plural(base: &str, count: u64) -> String {
    let (template, digits) = read(|store| {
        let Some(store) = store else {
            return (None, None);
        };
        let table = &store.categories;
        let index = usize::try_from(count).ok().and_then(|count| {
            if count < table.len() {
                Some(count)
            } else if table.len() >= MAX_CATEGORY_TABLE {
                Some(100 + count % 100)
            } else {
                None
            }
        });
        let category = index
            .and_then(|index| table.get(index).copied())
            .unwrap_or("other");
        let template = store
            .labels
            .get(&format!("{base}.{category}"))
            .or_else(|| store.labels.get(&format!("{base}.other")))
            .cloned();
        (template, store.digits)
    });
    let template = template.unwrap_or_else(|| english_plural(base, count));
    template.replace("{count}", &localized_digits(count, digits.as_ref()))
}

/// Title, body and button text of one native confirmation.
pub(crate) struct ConfirmCopy {
    title: String,
    message: String,
    confirm: String,
    cancel: String,
}

/// Quit with `active` local runs still going (`active > 0`).
pub(crate) fn quit_confirmation(active: u64) -> ConfirmCopy {
    ConfirmCopy {
        title: label(ids::QUIT_TITLE),
        message: plural(ids::QUIT_MESSAGE, active),
        confirm: label(ids::QUIT_CONFIRM),
        cancel: label(ids::QUIT_CANCEL),
    }
}

/// Install an app update, which restarts Ryu and stops `active` local runs.
pub(crate) fn update_confirmation(active: u64) -> ConfirmCopy {
    ConfirmCopy {
        title: label(ids::UPDATE_TITLE),
        message: if active > 0 {
            plural(ids::UPDATE_MESSAGE_ACTIVE, active)
        } else {
            label(ids::UPDATE_MESSAGE_IDLE)
        },
        confirm: label(ids::UPDATE_CONFIRM),
        cancel: label(ids::UPDATE_CANCEL),
    }
}

/// Show a warning confirmation; `on_answer(true)` means the confirm button.
pub(crate) fn show_confirm<R: Runtime>(
    app: &AppHandle<R>,
    copy: ConfirmCopy,
    on_answer: impl FnOnce(bool) + Send + 'static,
) {
    app.dialog()
        .message(copy.message)
        .title(copy.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            copy.confirm,
            copy.cancel,
        ))
        .show(on_answer);
}

/// The macOS application menu: Tauri's default layout and standard roles
/// (Services, Hide, Window, Edit for the webview's copy and paste), with
/// labels in the UI language. Rebuilt whenever the webview sends new copy.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let info = app.package_info();
    let name = info.name.clone();
    let text = |id: &str| label(id).replace("{app}", &name);
    let about = AboutMetadata {
        name: Some(name.clone()),
        version: Some(info.version.to_string()),
        copyright: app.config().bundle.copyright.clone(),
        authors: app
            .config()
            .bundle
            .publisher
            .clone()
            .map(|publisher| vec![publisher]),
        ..Default::default()
    };
    let separator = || PredefinedMenuItem::separator(app);
    let app_submenu = Submenu::with_items(
        app,
        name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&text(ids::MENU_ABOUT)), Some(about))?,
            &separator()?,
            &PredefinedMenuItem::services(app, Some(&text(ids::MENU_SERVICES)))?,
            &separator()?,
            &PredefinedMenuItem::hide(app, Some(&text(ids::MENU_HIDE)))?,
            &PredefinedMenuItem::hide_others(app, Some(&text(ids::MENU_HIDE_OTHERS)))?,
            &PredefinedMenuItem::show_all(app, Some(&text(ids::MENU_SHOW_ALL)))?,
            &separator()?,
            &PredefinedMenuItem::quit(app, Some(&text(ids::MENU_QUIT)))?,
        ],
    )?;
    let file = Submenu::with_items(
        app,
        text(ids::MENU_FILE),
        true,
        &[&PredefinedMenuItem::close_window(
            app,
            Some(&text(ids::MENU_CLOSE_WINDOW)),
        )?],
    )?;
    let edit = Submenu::with_items(
        app,
        text(ids::MENU_EDIT),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&text(ids::MENU_UNDO)))?,
            &PredefinedMenuItem::redo(app, Some(&text(ids::MENU_REDO)))?,
            &separator()?,
            &PredefinedMenuItem::cut(app, Some(&text(ids::MENU_CUT)))?,
            &PredefinedMenuItem::copy(app, Some(&text(ids::MENU_COPY)))?,
            &PredefinedMenuItem::paste(app, Some(&text(ids::MENU_PASTE)))?,
            &PredefinedMenuItem::select_all(app, Some(&text(ids::MENU_SELECT_ALL)))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        text(ids::MENU_VIEW),
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some(&text(ids::MENU_FULLSCREEN)),
        )?],
    )?;
    // The reserved ids make AppKit treat these as the Window and Help menus.
    let window = Submenu::with_id_and_items(
        app,
        tauri::menu::WINDOW_SUBMENU_ID,
        text(ids::MENU_WINDOW),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&text(ids::MENU_MINIMIZE)))?,
            &PredefinedMenuItem::maximize(app, Some(&text(ids::MENU_ZOOM)))?,
            &separator()?,
            &PredefinedMenuItem::close_window(app, Some(&text(ids::MENU_CLOSE_WINDOW)))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(
        app,
        tauri::menu::HELP_SUBMENU_ID,
        text(ids::MENU_HELP),
        true,
        &[],
    )?;
    Menu::with_items(app, &[&app_submenu, &file, &edit, &view, &window, &help])
}

/// Store the webview's translated shell copy and relabel what is on screen.
#[tauri::command]
pub fn set_native_copy(app: AppHandle, copy: NativeShellCopy) -> Result<(), String> {
    crate::webview_locale::remember(copy.locale.as_deref(), copy.language_mode.as_deref());
    replace_store(sanitize(copy)?);
    crate::tray::relabel_tray(&app);
    #[cfg(target_os = "macos")]
    {
        let menu = app_menu(&app).map_err(|error| error.to_string())?;
        app.set_menu(menu).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The OS's preferred UI languages, best first, as BCP 47 tags. WKWebView's
/// `navigator.language` reports the bundle's development region (English) when
/// the app declares no localizations, so auto mode asks the OS instead.
#[tauri::command]
pub fn get_os_preferred_languages() -> Vec<String> {
    let mut languages = Vec::new();
    for tag in os::preferred_languages() {
        let tag = normalize_tag(&tag);
        if !tag.is_empty() && !languages.contains(&tag) && languages.len() < 32 {
            languages.push(tag);
        }
    }
    languages
}

/// `pt_BR.UTF-8@euro` -> `pt-BR`; `C`/`POSIX` and malformed tags -> empty.
fn normalize_tag(raw: &str) -> String {
    let base = raw
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .trim()
        .replace('_', "-");
    let valid = base.len() <= 35
        && base.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && base.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    if !valid || base.eq_ignore_ascii_case("c") || base.eq_ignore_ascii_case("posix") {
        return String::new();
    }
    base
}

mod os;
#[cfg(test)]
mod tests;
