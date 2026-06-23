// ghost-hands: cross-platform UI action synthesis.
// All functions are synchronous (platform API calls are blocking).
// Callers should use tokio::task::spawn_blocking for async contexts.

mod click;
mod keyboard;
mod scroll;
mod window;

pub use click::{drag, hover, long_press, mouse_click, MouseButton};
pub use keyboard::{press_key, send_hotkey, type_text};
pub use scroll::scroll;
pub use window::{focus_app, window_action, WindowAction};
