#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{DragDropEvent, Manager, RunEvent, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

struct SidecarState(Mutex<Option<CommandChild>>);

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("failed to bind ephemeral localhost port")
        .local_addr()
        .expect("failed to read local addr")
        .port()
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(60));
    }
    false
}

fn build_enriched_path() -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();

    #[cfg(target_os = "windows")]
    let sep = ";";
    #[cfg(not(target_os = "windows"))]
    let sep = ":";

    let mut extras: Vec<String> = Vec::new();
    if !home.is_empty() {
        #[cfg(target_os = "windows")]
        {
            extras.push(format!("{}\\.local\\bin", home));
            extras.push(format!("{}\\.bun\\bin", home));
            extras.push(format!("{}\\AppData\\Roaming\\npm", home));
            extras.push(format!("{}\\AppData\\Local\\Programs\\Git\\cmd", home));
            extras.push("C:\\Program Files\\Git\\cmd".to_string());
        }
        #[cfg(not(target_os = "windows"))]
        {
            extras.push(format!("{}/.local/bin", home));
            extras.push(format!("{}/.bun/bin", home));
            extras.push(format!("{}/.cargo/bin", home));
            extras.push(format!("{}/.npm-global/bin", home));
            extras.push(format!("{}/.volta/bin", home));
            extras.push("/opt/homebrew/bin".to_string());
            extras.push("/opt/homebrew/sbin".to_string());
            extras.push("/usr/local/bin".to_string());
        }
    }

    let mut parts: Vec<String> = Vec::new();
    for p in extras.into_iter().chain(existing.split(sep).map(|s| s.to_string())) {
        if !p.is_empty() && !parts.contains(&p) {
            parts.push(p);
        }
    }
    parts.join(sep)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let port = pick_free_port();
            let port_str = port.to_string();
            let enriched_path = build_enriched_path();

            let sidecar_cmd = app
                .shell()
                .sidecar("diffgloss-engine")?
                .env("PATH", enriched_path)
                .args(["ui", "--port", &port_str]);
            let (_rx, child) = sidecar_cmd.spawn()?;

            {
                let state = app.state::<SidecarState>();
                *state.0.lock().unwrap() = Some(child);
            }

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if wait_for_port(port, Duration::from_secs(12)) {
                    if let Some(win) = handle.get_webview_window("main") {
                        let target = format!("http://127.0.0.1:{}/", port);
                        if let Ok(url) = target.parse() {
                            let _ = win.navigate(url);
                        }
                    }
                }
            });

            // Native OS drag-and-drop bridge: dragging any Git repo folder onto the
            // Diffgloss window immediately loads its diff in the workbench UI.
            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::DragDrop(drop_ev) = event {
                        match drop_ev {
                            DragDropEvent::Enter { .. } => {
                                let _ = win_clone.eval(
                                    "window.__diffglossSetDropActive && window.__diffglossSetDropActive(true);",
                                );
                            }
                            DragDropEvent::Leave => {
                                let _ = win_clone.eval(
                                    "window.__diffglossSetDropActive && window.__diffglossSetDropActive(false);",
                                );
                            }
                            DragDropEvent::Drop { paths, .. } => {
                                if let Some(first) = paths.first() {
                                    if let Ok(json_path) =
                                        serde_json::to_string(&first.to_string_lossy().to_string())
                                    {
                                        let script = format!(
                                            "window.__diffglossLoadRepo && window.__diffglossLoadRepo({});",
                                            json_path
                                        );
                                        let _ = win_clone.eval(&script);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Diffgloss desktop app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            let state = app_handle.state::<SidecarState>();
            let mut guard = state.0.lock().unwrap();
            if let Some(child) = guard.take() {
                let _ = child.kill();
            }
        }
    });
}
