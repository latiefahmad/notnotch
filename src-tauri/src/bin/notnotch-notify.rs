//! notnotch-notify: sends a notice to the running NotNotch over its per-user named pipe.
//!
//!   notnotch-notify "Build finished" -b "Tests passed"
//!   notnotch-notify "Deploying" -r deploy -p 40
//!   notnotch-notify run -- cargo test
//!   notnotch-notify part build "Compiling" -i build -p 40 -o terminal
//!   notnotch-notify part build --clear
//!   notnotch-notify ask --title "Run command?" --body "cargo test" -s Agent
//!
//! Exit codes: 0 delivered, 1 usage error, 2 rejected (invalid or rate limited), 3 NotNotch not running, notices off,
//! or no answer in time. `run` returns the command's own exit code. `ask` prints the chosen option id and exits 0,
//! or exits 4 when no choice was made (timed out, closed, NotNotch quit).

#[cfg(windows)]
#[path = "../notify_wire.rs"]
mod notify_wire;

#[cfg(windows)]
use std::io::{Read, Write};
#[cfg(windows)]
use std::process::ExitCode;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use notify_wire::{Reply, Request};

#[cfg(windows)]
const USAGE: &str = "Usage:
  notnotch-notify <title> [-b|--body <text>] [-s|--source <name>] [-r|--replace <key>] [-p|--progress <0-100>]
  notnotch-notify run [-s <name>] [-r <key>] -- <command> [args...]
  notnotch-notify part <id> [text] [-i|--icon <name>] [-p|--progress <0-100>] [-o|--open <tool>] [-t|--ttl <seconds>]
  notnotch-notify part <id> --clear
  notnotch-notify ask [--title] <text> [-b|--body <text>] [-s|--source <name>] [-o|--options <ids>] [-t|--timeout <seconds>]

  -j, --json <text|->  take the body from an agent hook's JSON (\"message\" or
                       \"last-assistant-message\"); - reads it from standard input.
                       --body is used when the JSON has neither.
  -q, --quiet          print nothing and always exit 0 (for hooks); with run, the
                       command's exit code is still returned.

Sends a notice to NotNotch. The same --replace key updates the notice shown before.
`part` sets a custom part of the closed notch (at most 48 characters; the same id updates it):
--icon is one of NotNotch's icon names (docs/plugins.md), --open the tool or plugin:<id> a click opens,
--ttl removes it after that many seconds (at most a day). NotNotch shows four such parts at most.
`ask` shows a question with one button per option (--options, default allow,always,deny; at most
four ids of a-z, 0-9 and -) and waits --timeout seconds (default 120, at most 600) for a click.
It prints the chosen id; with no choice it prints nothing and exits 4. --quiet keeps its exit code.
Exit codes: 0 delivered, 1 usage error, 2 rejected, 3 NotNotch not running or notices off, 4 no choice.
`run` returns the command's exit code. A command Windows cannot start directly (a .cmd
script such as npm) is run through cmd /d /c, which parses & | ^ < > in its arguments.";

#[cfg(windows)]
static QUIET: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
/// eprintln unless --quiet.
macro_rules! say {
    ($($t:tt)*) => {
        if !QUIET.load(std::sync::atomic::Ordering::Relaxed) {
            eprintln!($($t)*);
        }
    };
}

#[cfg(windows)]
/// --quiet among notnotch-notify's own options (a -q after `--` belongs to the command).
fn is_quiet(args: &[String]) -> bool {
    args.iter().take_while(|a| *a != "--").any(|a| a == "-q" || a == "--quiet")
}

#[cfg(windows)]
#[derive(Debug, PartialEq)]
enum Command {
    Help,
    /// The request and a --json value ("-" = standard input) to take the body from.
    Send(Request, Option<String>),
    Run(Request, Vec<String>),
    Ask(Request),
}

#[cfg(windows)]
fn parse_args(args: &[String]) -> Result<Command, String> {
    let mut r = Request::default();
    let mut words: Vec<String> = Vec::new();
    let mut run = false;
    let mut json = None;
    let mut i = 0;
    let value = |i: usize, flag: &str| args.get(i + 1).cloned().ok_or_else(|| format!("{flag} needs a value"));
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-h" | "--help" => return Ok(Command::Help),
            // Read by is_quiet.
            "-q" | "--quiet" => {}
            "run" if i == 0 => run = true,
            "part" if i == 0 => return parse_part(&args[1..]),
            "ask" if i == 0 => return parse_ask(&args[1..]),
            "--" if run => {
                let command: Vec<String> = args[i + 1..].to_vec();
                if command.is_empty() {
                    return Err("run needs a command after --".into());
                }
                return Ok(Command::Run(r, command));
            }
            "-b" | "--body" => {
                r.body = Some(value(i, a)?);
                i += 1;
            }
            "-j" | "--json" => {
                json = Some(value(i, a)?);
                i += 1;
            }
            "-s" | "--source" => {
                r.source = Some(value(i, a)?);
                i += 1;
            }
            "-r" | "--replace" => {
                r.replace = Some(value(i, a)?);
                i += 1;
            }
            "-p" | "--progress" => {
                r.progress = Some(progress(&value(i, a)?)?);
                i += 1;
            }
            _ if a.starts_with('-') && a.len() > 1 => return Err(format!("unknown option {a}")),
            _ => words.push(a.to_string()),
        }
        i += 1;
    }
    if run {
        return Err("run needs -- before the command".into());
    }
    if !words.is_empty() {
        r.title = Some(words.join(" "));
    }
    if r.title.is_none() && r.body.is_none() && json.is_none() {
        return Err("a title or --body is needed".into());
    }
    Ok(Command::Send(r, json))
}

#[cfg(windows)]
fn progress(v: &str) -> Result<f64, String> {
    match v.parse::<f64>() {
        Ok(p) if p.is_finite() && (0.0..=100.0).contains(&p) => Ok(p),
        _ => Err("progress must be a number from 0 to 100".into()),
    }
}

#[cfg(windows)]
/// `part <id> [text] [options]`: the words after the id are the text. NotNotch checks the values again.
fn parse_part(args: &[String]) -> Result<Command, String> {
    let mut p = notify_wire::Part::default();
    let mut source = None;
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    let value = |i: usize, flag: &str| args.get(i + 1).cloned().ok_or_else(|| format!("{flag} needs a value"));
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-h" | "--help" => return Ok(Command::Help),
            "-q" | "--quiet" => {}
            "-c" | "--clear" => p.clear = true,
            "-i" | "--icon" => {
                p.icon = Some(value(i, a)?);
                i += 1;
            }
            "-p" | "--progress" => {
                p.progress = Some(progress(&value(i, a)?)?);
                i += 1;
            }
            "-o" | "--open" => {
                p.open = Some(value(i, a)?);
                i += 1;
            }
            "-t" | "--ttl" => {
                p.ttl = Some(value(i, a)?.parse().map_err(|_| "ttl must be a whole number of seconds".to_string())?);
                i += 1;
            }
            "-s" | "--source" => {
                source = Some(value(i, a)?);
                i += 1;
            }
            _ if a.starts_with('-') && a.len() > 1 => return Err(format!("unknown option {a}")),
            _ => words.push(a.to_string()),
        }
        i += 1;
    }
    let mut words = words.into_iter();
    p.id = words.next().ok_or("part needs an id")?;
    let text: Vec<String> = words.collect();
    if !text.is_empty() {
        p.text = Some(text.join(" "));
    }
    if !p.clear && p.text.is_none() && p.progress.is_none() {
        return Err("part needs a text, --progress or --clear".into());
    }
    Ok(Command::Send(Request { part: Some(p), source, ..Default::default() }, None))
}

#[cfg(windows)]
/// `ask [title words] [options]`. The options are checked here too, so a typo fails before anything shows.
fn parse_ask(args: &[String]) -> Result<Command, String> {
    let mut r = Request::default();
    let mut options = "allow,always,deny".to_string();
    let mut timeout = 120u64;
    let mut words: Vec<String> = Vec::new();
    let mut i = 0;
    let value = |i: usize, flag: &str| args.get(i + 1).cloned().ok_or_else(|| format!("{flag} needs a value"));
    while i < args.len() {
        let a = args[i].as_str();
        match a {
            "-h" | "--help" => return Ok(Command::Help),
            "-q" | "--quiet" => {}
            "--title" => {
                r.title = Some(value(i, a)?);
                i += 1;
            }
            "-b" | "--body" => {
                r.body = Some(value(i, a)?);
                i += 1;
            }
            "-s" | "--source" => {
                r.source = Some(value(i, a)?);
                i += 1;
            }
            "-o" | "--options" => {
                options = value(i, a)?;
                i += 1;
            }
            "-t" | "--timeout" => {
                timeout = value(i, a)?.parse().map_err(|_| "timeout must be a whole number of seconds".to_string())?;
                i += 1;
            }
            _ if a.starts_with('-') && a.len() > 1 => return Err(format!("unknown option {a}")),
            _ => words.push(a.to_string()),
        }
        i += 1;
    }
    if !words.is_empty() {
        let joined = words.join(" ");
        r.title = Some(r.title.map_or(joined.clone(), |t| format!("{t} {joined}")));
    }
    if r.title.is_none() && r.body.is_none() {
        return Err("ask needs a --title or --body".into());
    }
    let options: Vec<String> = options.split(',').map(|o| o.trim().to_string()).collect();
    if let Some(bad) = options.iter().find(|o| !notify_wire::option_ok(o)) {
        return Err(format!("option id \"{bad}\" must be 1 to {} characters of a-z, 0-9 and -", notify_wire::MAX_FIELD));
    }
    if options.len() > notify_wire::MAX_ASK_OPTIONS || options.iter().enumerate().any(|(i, o)| options[..i].contains(o)) {
        return Err(format!("at most {} different options", notify_wire::MAX_ASK_OPTIONS));
    }
    if !(1..=notify_wire::MAX_ASK_TIMEOUT).contains(&timeout) {
        return Err(format!("timeout must be 1 to {} seconds", notify_wire::MAX_ASK_TIMEOUT));
    }
    r.ask = Some(notify_wire::Ask { options, timeout });
    Ok(Command::Ask(r))
}

#[cfg(windows)]
/// The --json value: the text itself, or standard input for "-" (a hook writes its event there and closes it).
fn read_json(spec: &str) -> Option<String> {
    if spec != "-" {
        return Some(spec.to_string());
    }
    let mut text = String::new();
    std::io::stdin().take(notify_wire::MAX_FRAME as u64 * 16).read_to_string(&mut text).ok()?;
    Some(text)
}

#[cfg(windows)]
/// The message in an agent hook's event: `message`, `last-assistant-message` or `last_assistant_message`. None when
/// there is none of them, so the --body given as a fallback stays.
fn body_from_json(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    ["message", "last-assistant-message", "last_assistant_message"]
        .iter()
        .find_map(|k| value.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
}

#[cfg(windows)]
#[derive(Debug, PartialEq)]
enum Server {
    Ours,
    /// Runs as another user, or as this user at a lower integrity level (a sandboxed process posing as NotNotch).
    Foreign,
    /// The server process could not be opened or read.
    Unverified,
}

#[cfg(windows)]
/// Who runs the server end of the pipe. Another account could create the pipe name first (pipe names are shared by
/// the whole machine), and its notices would go to that account.
fn server_owner(pipe: &std::fs::File) -> Server {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    let mut pid = 0u32;
    if unsafe { GetNamedPipeServerProcessId(HANDLE(pipe.as_raw_handle()), &mut pid) }.is_err() {
        return Server::Unverified;
    }
    let (Some(server), Some(own)) = (notify_wire::pid_token(pid), notify_wire::own_token()) else { return Server::Unverified };
    judge(&server, &own)
}

#[cfg(windows)]
/// Ours when the user matches and the server's integrity level is not below ours.
fn judge(server: &(String, u32), own: &(String, u32)) -> Server {
    if server.0 == own.0 && server.1 >= own.1 {
        Server::Ours
    } else {
        Server::Foreign
    }
}

#[cfg(windows)]
/// Sends one request and waits for the reply; the exit code for the outcome.
fn send(request: &Request) -> u8 {
    match exchange(request, Duration::from_secs(3)) {
        Ok(Some(reply)) => verdict(reply),
        Ok(None) => {
            say!("notnotch-notify: NotNotch did not answer");
            3
        }
        Err(code) => code,
    }
}

#[cfg(windows)]
/// Asks a question and waits up to its timeout; prints the chosen option id. 4 when no choice was made.
fn ask(request: &Request) -> u8 {
    let ask = request.ask.as_ref().expect("an ask request");
    match exchange(request, Duration::from_secs(ask.timeout)) {
        Ok(Some(Reply { result, choice: Some(c), .. })) if result == "answered" && ask.options.contains(&c) => {
            println!("{c}");
            0
        }
        // "accepted": an older NotNotch showed it as a plain notice.
        Ok(Some(r)) if r.result == "unanswered" || r.result == "accepted" => {
            say!("notnotch-notify: no choice was made");
            4
        }
        Ok(Some(r)) => verdict(r),
        Ok(None) => {
            say!("notnotch-notify: no choice was made in time");
            4
        }
        Err(code) => code,
    }
}

#[cfg(windows)]
/// The exit code for a reply to a notice.
fn verdict(reply: Reply) -> u8 {
    match reply.result.as_str() {
        "accepted" => 0,
        "limited" => {
            say!("notnotch-notify: too many notices, try again in a few seconds");
            2
        }
        "rejected" => {
            let why = reply.reason.unwrap_or_default();
            say!("notnotch-notify: notice rejected ({why})");
            2
        }
        "off" => {
            say!("notnotch-notify: live notices are off in NotNotch");
            3
        }
        _ => {
            say!("notnotch-notify: unexpected answer from NotNotch");
            3
        }
    }
}

#[cfg(windows)]
/// Connects, checks the server, writes the request and waits up to `wait` for one reply line. Ok(None) when none
/// came (no answer in time, or NotNotch closed the channel); Err with the exit code when it could not be sent.
fn exchange(request: &Request, wait: Duration) -> Result<Option<Reply>, u8> {
    let Some(line) = notify_wire::encode(request) else {
        say!("notnotch-notify: the notice is larger than 64 KB");
        return Err(1);
    };
    let Some((session, sid)) = notify_wire::identity() else {
        say!("notnotch-notify: cannot read the current user");
        return Err(3);
    };
    let name = notify_wire::pipe_name(session, &sid);
    // The server opens the next instance right after taking a client; a busy pipe (error 231) only waits a moment.
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut pipe = loop {
        use std::os::windows::fs::OpenOptionsExt;
        // Identification only: a server that is not NotNotch cannot act as this user with our handle.
        let qos = windows::Win32::Storage::FileSystem::SECURITY_IDENTIFICATION.0;
        match std::fs::OpenOptions::new().read(true).write(true).security_qos_flags(qos).open(&name) {
            Ok(p) => break p,
            Err(e) if e.raw_os_error() == Some(231) && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                say!("notnotch-notify: NotNotch is not running, or live notices are off");
                return Err(3);
            }
        }
    };
    match server_owner(&pipe) {
        Server::Ours => {}
        Server::Foreign => {
            say!("notnotch-notify: the notice channel is not NotNotch's (another user or a lower integrity level); nothing was sent");
            return Err(3);
        }
        Server::Unverified => {
            say!("notnotch-notify: NotNotch could not be verified at the other end of the channel; nothing was sent");
            return Err(3);
        }
    }
    if pipe.write_all(&line).and_then(|_| pipe.flush()).is_err() {
        say!("notnotch-notify: NotNotch closed the connection");
        return Err(3);
    }
    // Read on a thread so a NotNotch that hangs cannot hold the caller (a hook, a build script) for long.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 512];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.contains(&b'\n') || buf.len() > 4096 {
                break;
            }
        }
        let _ = tx.send(buf);
    });
    let Ok(buf) = rx.recv_timeout(wait) else { return Ok(None) };
    Ok(match notify_wire::take_line(&buf) {
        notify_wire::Frame::Line(l) => serde_json::from_slice::<Reply>(&l).ok(),
        _ => None,
    })
}

#[cfg(windows)]
fn run(mut request: Request, command: Vec<String>) -> ExitCode {
    let started = Instant::now();
    let mut status = std::process::Command::new(&command[0]).args(&command[1..]).status();
    // Windows only finds .exe files this way; npm, yarn and other .cmd scripts need cmd.
    if matches!(&status, Err(e) if e.kind() == std::io::ErrorKind::NotFound) {
        status = std::process::Command::new("cmd").args(["/d", "/c"]).args(&command).status();
    }
    let (code, failed_to_start) = match status {
        Ok(s) => (s.code().unwrap_or(1), false),
        Err(e) => {
            say!("notnotch-notify: cannot start {}: {e}", command[0]);
            (127, true)
        }
    };
    request.command = Some(command.join(" "));
    request.exit_code = Some(code);
    request.duration_ms = Some(if failed_to_start { 0 } else { started.elapsed().as_millis() as u64 });
    // The command's result matters more than whether the notice arrived.
    let _ = send(&request);
    // The full 32-bit code (a crash's 0xC0000005 must not come back as 0).
    std::process::exit(code)
}

/// The notice pipe and its peer check are Windows-only for now; on a Mac this binary only says so.
#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    eprintln!("notnotch-notify: not available on this system yet");
    std::process::ExitCode::FAILURE
}

#[cfg(windows)]
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let quiet = is_quiet(&args);
    QUIET.store(quiet, std::sync::atomic::Ordering::Relaxed);
    // A hook that fails can stop or warn its agent; --quiet never does. An ask keeps its code: it is the answer.
    let code = outcome(&args);
    if quiet && args.first().map(String::as_str) != Some("ask") {
        ExitCode::SUCCESS
    } else {
        code
    }
}

#[cfg(windows)]
fn outcome(args: &[String]) -> ExitCode {
    match parse_args(args) {
        Ok(Command::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(Command::Send(mut r, json)) => {
            if let Some(text) = json.and_then(|j| read_json(&j)).and_then(|t| body_from_json(&t)) {
                r.body = Some(text);
            }
            if r.title.is_none() && r.body.is_none() && r.part.is_none() {
                say!("notnotch-notify: the JSON had no message and no title or --body was given");
                return ExitCode::from(1);
            }
            ExitCode::from(send(&r))
        }
        Ok(Command::Run(r, command)) => run(r, command),
        Ok(Command::Ask(r)) => ExitCode::from(ask(&r)),
        Err(e) => {
            say!("notnotch-notify: {e}\n\n{USAGE}");
            ExitCode::from(1)
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn send_args() {
        let Ok(Command::Send(r, None)) = parse_args(&args(&["Build", "done", "-b", "ok", "-r", "b1", "-p", "40"])) else { panic!() };
        assert_eq!(r.title.as_deref(), Some("Build done"));
        assert_eq!(r.body.as_deref(), Some("ok"));
        assert_eq!(r.replace.as_deref(), Some("b1"));
        assert_eq!(r.progress, Some(40.0));
        assert!(matches!(parse_args(&args(&["--body", "only"])), Ok(Command::Send(_, None))));
        assert_eq!(parse_args(&args(&["-h"])), Ok(Command::Help));
    }

    #[test]
    fn errors() {
        assert!(parse_args(&args(&[])).is_err());
        assert!(parse_args(&args(&["t", "-b"])).is_err());
        assert!(parse_args(&args(&["t", "-p", "120"])).is_err());
        assert!(parse_args(&args(&["t", "-p", "NaN"])).is_err());
        assert!(parse_args(&args(&["t", "--nope"])).is_err());
        assert!(parse_args(&args(&["run", "cargo"])).is_err());
        assert!(parse_args(&args(&["run", "--"])).is_err());
    }

    #[test]
    fn run_args() {
        let Ok(Command::Run(r, cmd)) = parse_args(&args(&["run", "-s", "CI", "--", "cargo", "test", "-q"])) else { panic!() };
        assert_eq!(r.source.as_deref(), Some("CI"));
        assert_eq!(cmd, args(&["cargo", "test", "-q"]));
        // A word "run" later is part of the title.
        assert!(matches!(parse_args(&args(&["Tests", "run"])), Ok(Command::Send(_, None))));
    }

    #[test]
    fn agent_json() {
        // An agent that appends its event as the last argument fills --json.
        let Ok(Command::Send(r, Some(j))) = parse_args(&args(&["Agent", "-s", "Agent", "--json", r#"{"type":"turn-complete","last-assistant-message":"Done."}"#])) else { panic!() };
        assert_eq!(r.title.as_deref(), Some("Agent"));
        assert_eq!(body_from_json(&j).as_deref(), Some("Done."));
        assert!(matches!(parse_args(&args(&["--json", "-"])), Ok(Command::Send(_, Some(_)))));
        assert_eq!(body_from_json(r#"{"hook_event_name":"Notification","message":" Needs input "}"#).as_deref(), Some("Needs input"));
        assert_eq!(body_from_json(r#"{"hook_event_name":"Stop"}"#), None);
        assert_eq!(body_from_json("not json"), None);
    }

    #[test]
    fn server_judgement() {
        let me = ("S-1-5-21-1".to_string(), 0x2000);
        assert_eq!(judge(&me, &me), Server::Ours);
        assert_eq!(judge(&("S-1-5-21-1".into(), 0x3000), &me), Server::Ours);
        assert_eq!(judge(&("S-1-5-21-1".into(), 0x1000), &me), Server::Foreign);
        assert_eq!(judge(&("S-1-5-21-2".into(), 0x2000), &me), Server::Foreign);
        let own = notify_wire::own_token().expect("own token");
        assert!(own.1 >= 0x1000, "integrity level {:#x}", own.1);
    }

    #[test]
    fn part_args() {
        let Ok(Command::Send(r, None)) = parse_args(&args(&["part", "build", "Compiling", "notnotch", "-i", "build", "-p", "40", "-o", "terminal", "-t", "60", "-s", "CI"])) else { panic!() };
        let p = r.part.unwrap();
        assert_eq!((p.id.as_str(), p.text.as_deref(), p.icon.as_deref(), p.progress, p.open.as_deref(), p.ttl), ("build", Some("Compiling notnotch"), Some("build"), Some(40.0), Some("terminal"), Some(60)));
        assert_eq!(r.source.as_deref(), Some("CI"));
        assert!(r.title.is_none());
        let Ok(Command::Send(r, None)) = parse_args(&args(&["part", "build", "--clear"])) else { panic!() };
        assert!(r.part.unwrap().clear);
        assert!(parse_args(&args(&["part"])).is_err());
        assert!(parse_args(&args(&["part", "build"])).is_err());
        assert!(parse_args(&args(&["part", "build", "x", "-t", "soon"])).is_err());
        assert!(parse_args(&args(&["part", "build", "x", "-p", "200"])).is_err());
        // Only as the first word.
        assert!(matches!(parse_args(&args(&["Build", "part"])), Ok(Command::Send(r, None)) if r.part.is_none()));
    }

    #[test]
    fn ask_args() {
        let Ok(Command::Ask(r)) = parse_args(&args(&["ask", "--title", "Run command?", "-b", "cargo test", "-s", "Agent"])) else { panic!() };
        assert_eq!((r.title.as_deref(), r.body.as_deref(), r.source.as_deref()), (Some("Run command?"), Some("cargo test"), Some("Agent")));
        assert_eq!(r.ask.unwrap(), notify_wire::Ask { options: args(&["allow", "always", "deny"]), timeout: 120 });
        let Ok(Command::Ask(r)) = parse_args(&args(&["ask", "Deploy", "now?", "-o", "yes, no", "-t", "600", "-q"])) else { panic!() };
        assert_eq!(r.title.as_deref(), Some("Deploy now?"));
        assert_eq!(r.ask.unwrap(), notify_wire::Ask { options: args(&["yes", "no"]), timeout: 600 });
        assert!(matches!(parse_args(&args(&["ask", "-b", "only a body"])), Ok(Command::Ask(_))));
        assert!(parse_args(&args(&["ask"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-t", "0"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-t", "601"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-t", "soon"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-o", "Allow"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-o", "a,,b"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-o", "a,b,c,d,e"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "-o", "a,a"])).is_err());
        assert!(parse_args(&args(&["ask", "q", "--json", "-"])).is_err());
        // Only as the first word.
        assert!(matches!(parse_args(&args(&["Please", "ask"])), Ok(Command::Send(r, None)) if r.ask.is_none()));
        // What the CLI builds, NotNotch accepts.
        let Ok(Command::Ask(r)) = parse_args(&args(&["ask", "q", "-o", "a,b-2,c,d"])) else { panic!() };
        let line = notify_wire::encode(&r).unwrap();
        assert_eq!(notify_wire::parse(&line[..line.len() - 1]).unwrap(), r);
    }

    #[test]
    fn quiet() {
        assert!(is_quiet(&args(&["t", "--quiet"])));
        assert!(is_quiet(&args(&["run", "-q", "--", "cargo", "test"])));
        // A -q after -- belongs to the command.
        assert!(!is_quiet(&args(&["run", "--", "cargo", "test", "-q"])));
        assert!(matches!(parse_args(&args(&["t", "-q"])), Ok(Command::Send(r, None)) if r.title.as_deref() == Some("t")));
    }
}
