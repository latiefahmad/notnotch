//! Backend check without UI: cargo run --example backend_check
fn main() {
    let rt = tauri::async_runtime::block_on(notnotch_lib::usage::probe_for_test());
    // Only print window counts or error codes, never account data.
    for (id, result) in rt {
        println!("usage {id}: {result:?}");
    }
}
