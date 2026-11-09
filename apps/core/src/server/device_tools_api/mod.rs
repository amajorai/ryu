//! HTTP surface of the device-tools lane (`/api/device-tools/*`, plus the
//! device halves of `/api/chat/stream` and `/api/chat/client-tool-result`).
//! The protocol itself lives in `crate::device_tools`.

mod auth;
mod chat;
mod confirm;
mod devices;
mod routes;
mod stream;

pub(in crate::server) use chat::*;
pub(in crate::server) use confirm::*;
pub(in crate::server) use devices::*;
pub(in crate::server) use routes::*;
pub(in crate::server) use stream::*;

#[cfg(test)]
mod chat_prompt_tests;
#[cfg(test)]
mod chat_tests;
#[cfg(test)]
mod devices_tests;
#[cfg(test)]
mod routes_tests;
#[cfg(test)]
mod stream_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_confirm;
#[cfg(test)]
mod tests_flag;
