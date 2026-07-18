// ghost-hands: cross-platform UI action synthesis.
// All functions are synchronous (platform API calls are blocking).
// Callers should use tokio::task::spawn_blocking for async contexts.

mod click;
mod keyboard;
pub mod mode;
mod scroll;
mod window;

#[cfg(target_os = "linux")]
mod linux;

pub use click::{
    ax_press_at, cursor_position, drag, execute_click, execute_drag, hover, long_press,
    mouse_click, warp_cursor, MouseButton,
};
pub use keyboard::{press_key, send_hotkey, type_text};
pub use mode::{plan_click, ClickMode, ClickPlan};
pub use scroll::scroll;
pub use window::{focus_app, window_action, WindowAction};
