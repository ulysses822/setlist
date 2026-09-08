// A release build owns no console, so nothing flashes one on launch. Debug builds stay
// console-subsystem on purpose: that terminal is where `tauri dev` prints, and it is what the
// git subprocesses inherit rather than each opening a window of their own (see CREATE_NO_WINDOW
// in git.rs, which is what covers them once this attribute takes effect).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    setlist_lib::run()
}
