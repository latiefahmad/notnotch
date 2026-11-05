# Live notices

NotNotch can show notifications in the closed notch: the app's logo, its name, the title and the first line of the text, for 6 seconds. The open notch gets a **Notices** page with everything that arrived since NotNotch started, each with a short time ("Now", "5 min", "14:05").

Turn it on under **Settings → Notices → Live notices**. It is off by default because it reads other apps' notifications.

## Sources

| Source | What it is | Default |
| --- | --- | --- |
| Windows notifications | The toast notifications Windows shows for your account, from any app | On once live notices are on |
| notnotch-notify | A small command line program for scripts, builds and coding agents | On once live notices are on |

### How NotNotch reads Windows notifications

Windows lets apps read the notifications in the action centre through its notification listener, after you allow it once (the **Allow access** button, or **Windows Settings → Privacy & security → Notifications**). The listener's "a notification arrived" event only reaches apps installed as a package, and NotNotch is a plain desktop program, so NotNotch watches a different signal: for every notification delivered to your account, Windows' push notification service writes an entry to the event log **Applications and Services Logs → Microsoft → Windows → PushNotification-Platform → Operational**. The entry holds the notification's number and the app's id. NotNotch subscribes to that log, filtered to your account, and reads that one notification through the listener. It checks that the notification belongs to the app the entry names, so an entry never brings up another app's text.

Nothing waits on a timer while this works: NotNotch does no work until Windows writes an entry. A notification Windows cannot return yet, or one that belongs to another app than the entry says, makes NotNotch read the whole list once instead, so it is not lost. When the log is turned off (some company policies do that) or the subscription fails, NotNotch reads the list every 5 seconds and tries the log again after 1 minute, then after 2, 4 and so on up to 30 minutes; **Settings → Notices** says which of the two is in use.

If Windows answers **Allow access** without showing a prompt (it may do that for a desktop program), the settings say so: turn on notification access for apps under **Windows Settings → Privacy & security → Notifications**, then open NotNotch's settings page again.

The first reading after starting is a baseline: what is already in the action centre is not shown again.

NotNotch only reads. It never removes, dismisses or changes a notification, never touches the action centre or other apps' notification settings, and never opens links from a notification.

Other ways were considered and left out. Reading Windows' notification database file (`wpndatabase.db`) depends on an undocumented format that changes between Windows builds and on a file the notification service keeps locked. Registering NotNotch as a package only to receive the event would need Developer Mode or a signed package.

## Rules and quiet hours

- **Per app**: every app that sent a notice is listed under **Settings → Notices → Apps** with **Show** (pops up), **Mute** (history only) or **Off** (dropped). The buttons next to a notice on the Notices page do the same.
- **Presentation mode**: while it is on (by hand or during a screen recording), notices go to the history without popping up, and the history page hides their text.
- **Every day**: a daily quiet window, for example 22:00 to 07:00, works the same way.
- **Full screen and focus**: while an app fills the notch's screen, or Windows focus or Do Not Disturb is on, notices also go to the history only.

In the closed notch a finished timer and status alerts come first, then notices, then quota alerts and new songs. Notices do not show on the line look or in focus mode; they still go to the history.

## notnotch-notify

`notnotch-notify.exe` is installed next to `notnotch.exe`, by default in `%LOCALAPPDATA%\NotNotch`. Add that folder to your `PATH`, or call it by its full path.

```text
# a notice
notnotch-notify "Build finished" -b "Tests passed"
# the same -r key updates the same notice, here with a progress ring
notnotch-notify "Deploying" -r deploy -p 40
notnotch-notify "Deployed" -r deploy -p 100
# run a command, then notify its exit code and how long it took
notnotch-notify run -s Tests -- cargo test
```

| Option | Meaning |
| --- | --- |
| `-b`, `--body <text>` | The text under the title |
| `-s`, `--source <name>` | Who sends it, shown as the app name; rules apply per source |
| `-r`, `--replace <key>` | A later notice from the same source with the same key replaces this one |
| `-p`, `--progress <0-100>` | Shows a progress ring |
| `-j`, `--json <text or ->` | Takes the body from an agent's event (`message` or `last-assistant-message`); `-` reads it from standard input. `--body` is used when the JSON has neither |
| `-q`, `--quiet` | Prints nothing and always exits 0, for hooks where a failing command would stop or warn the agent. With `run` the command's own exit code is still returned |

`run` starts the command with your console, waits for it, sends the result and returns the command's own exit code. Commands that Windows cannot start directly, such as the `.cmd` scripts of npm and yarn, are started through `cmd /d /c`. `cmd` then reads the arguments again, so `&`, `|`, `^`, `<` and `>` in them act as `cmd` operators; quote such arguments for `cmd`, or call `cmd /c` yourself.

Exit codes: 0 delivered (also when your rules keep it quiet), 1 usage error, 2 rejected (malformed, or more than 200 notices in 10 seconds), 3 NotNotch is not running, live notices or notnotch-notify are off, the channel belongs to another account, or NotNotch did not answer within 3 seconds.

Titles are cut to 256 characters, texts to 4000, a message to 64 KB. Control characters and the characters that reverse text direction are removed.

### Custom parts in the closed row

`notnotch-notify part` puts a small part of your own in the closed notch's row, next to the clock and the timer: an icon, a short text and an optional progress bar. It stays until you clear it, its time runs out or NotNotch quits. Turn on **Script parts (notnotch-notify)** under **Settings → Display** and place it among the other parts.

```text
# set (the same id updates it)
notnotch-notify part build "Compiling" -i build -p 40 -o terminal
notnotch-notify part build "Tests" -i check -p 90
# remove it
notnotch-notify part build --clear
# a part that goes by itself after ten minutes
notnotch-notify part deploy "Deploying v2" -i rocket -t 600
```

| Option | Meaning |
| --- | --- |
| `<id>` | 1 to 32 characters: lowercase letters, digits, `-` and `_` |
| `[text]` | Up to 48 characters; the words after the id |
| `-i`, `--icon <name>` | One of NotNotch's icons (the list is in [plugins.md](plugins.md#icons)); nothing is loaded from outside |
| `-p`, `--progress <0-100>` | A small bar after the text |
| `-o`, `--open <tool>` | The tool a click opens: a tool id such as `timer`, `terminal`, `notices`, or `plugin:<id>` for a plugin; it only works while that tool is on |
| `-t`, `--ttl <seconds>` | Removes the part after that many seconds, at most a day |
| `-c`, `--clear` | Removes the part |
| `-s`, `--source <name>` | Shown as the tooltip |

A part needs a text or a progress value. At most four parts show; a fifth replaces the one set longest ago. Parts are kept in memory only, so a script sets them again after NotNotch restarts. They use the same channel, rate limit and exit codes as notices, and need live notices and notnotch-notify on.

### Questions from scripts and coding agents

`notnotch-notify ask` puts a question in the closed notch with one button per option and waits for your click, so a script or a coding agent can ask "may I run this command?" without you switching to its terminal. It prints the id of the option you picked and exits 0.

```text
notnotch-notify ask --title "Run command?" --body "cargo test" -s Agent
allow
```

| Option | Meaning |
| --- | --- |
| `--title <text>` | The question; words without an option are added to it |
| `-b`, `--body <text>` | The details, such as the command; shown on one line after the title |
| `-s`, `--source <name>` | Who asks, shown as the app name; the per-app rule applies |
| `-o`, `--options <ids>` | Comma-separated option ids, one button each, at most four. An id is up to 128 characters of `a-z`, `0-9` and `-`. Default `allow,always,deny`, shown as **Allow**, **Always allow** and **Deny**; other ids show as written |
| `-t`, `--timeout <seconds>` | How long it waits, 1 to 600, default 120 |
| `-q`, `--quiet` | Prints no error messages; unlike for notices, the exit code stays, since it is the answer |

The question stays until you answer it: a click on an option answers, the close button answers "no choice". Several questions wait in turn, oldest first. A question shows over the other notices (only a recording and a finished timer come first), also on the idle line and in focus mode. Quiet hours, focus, Do Not Disturb and full-screen apps do not hold it back, since you started the work that asks. It plays no sound and is not kept in the history. When its source is set to **Off**, or presentation mode is on, NotNotch answers "no choice" at once instead of showing it, so the caller does not wait. On the left and right edges it shows as the app's logo with round buttons; their names show as tooltips.

Exit codes: 0 an option was picked (its id is on standard output), 1 usage error, 2 rejected (malformed, too many notices, or more than 8 questions open at once), 3 NotNotch is not running, live notices or notnotch-notify are off, or the channel belongs to another account, 4 no choice: the time ran out, you closed the question, NotNotch quit or its notices were switched off, or the NotNotch running is too old to ask. In every case but 0 nothing is printed on standard output, so a script can fall back to its usual prompt.

### Hooks for coding agents

NotNotch does not change any agent's configuration; copy what you need.

**Claude Code** (`hooks` in `~/.claude/settings.json` or a project's `.claude/settings.json`): a notice when it needs your input and when it finishes a turn. Both events write their details to standard input; `--json -` takes the message from there, and `-b` is the text when there is none. `-q` keeps the hook from ever failing: a Stop hook that exits with code 2 would keep the agent working.

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "notnotch-notify \"Claude Code\" -s \"Claude Code\" -r claude-code -b \"Needs your input\" --json - -q" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "notnotch-notify \"Claude Code\" -s \"Claude Code\" -r claude-code -b \"Finished\" --json - -q" }] }
    ]
  }
}
```

**Codex** (`~/.codex/config.toml`): Codex runs the `notify` program at the end of each turn and adds its event as the last argument, which fills `--json`, so `--json` has to stay last.

```toml
notify = ["notnotch-notify", "Codex", "-s", "Codex", "-r", "codex", "-b", "Turn finished", "-q", "--json"]
```

#### Answering permission requests from the notch

Coding agents that support command hooks can run a script when they need permission for a tool call and take its answer instead of asking in the terminal. The script calls `notnotch-notify ask`, waits for your click and turns the option into the reply the agent expects. When `ask` exits with anything but 0, the script prints nothing and exits 0, which leaves the decision to the agent's own prompt.

For **Claude Code**, the `PermissionRequest` hook writes the request to standard input (`tool_name`, `tool_input` and `permission_suggestions`) and reads a `decision` from standard output. Save this as `notnotch-ask.ps1`:

```powershell
# Answers a permission request from NotNotch's notch; without an answer the agent asks in the terminal as usual.
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$req = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8).ReadToEnd() | ConvertFrom-Json
$detail = $req.tool_input.command
if (-not $detail) { $detail = $req.tool_input.file_path }
if (-not $detail) { $detail = $req.tool_input | ConvertTo-Json -Compress }
# Windows PowerShell passes quotes to programs unescaped; escape them (and backslashes before them) by hand.
function Arg($s) { "$s" -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1' }
$choice = notnotch-notify ask --title (Arg $req.tool_name) --body (Arg $detail) -s "Claude Code" -t 120 -q
if ($LASTEXITCODE -ne 0) { exit 0 }
$decision = switch ($choice) {
  "allow"  { @{ behavior = "allow" } }
  # The agent's own "always allow" suggestion, saved as its permission rule.
  "always" { @{ behavior = "allow"; updatedPermissions = @($req.permission_suggestions | Where-Object { $_ }) } }
  default  { @{ behavior = "deny"; message = "Denied from the notch" } }
}
@{ hookSpecificOutput = @{ hookEventName = "PermissionRequest"; decision = $decision } } | ConvertTo-Json -Depth 10 -Compress
```

Then add the hook to `~/.claude/settings.json`, with the path to the script. The matcher limits it to shell commands; leave it out to be asked for every tool. The hook's `timeout` must be longer than the one given to `ask`.

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe",
            "args": ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:/Users/you/notnotch-ask.ps1"],
            "timeout": 150
          }
        ]
      }
    ]
  }
}
```

A deny rule in the agent's own settings still wins over **Allow**. With NotNotch closed, or no click within two minutes, the terminal prompt appears as before.

If `notnotch-notify` is not on your `PATH`, put the full path in its place, for example `C:/Users/you/AppData/Local/NotNotch/notnotch-notify.exe`.

## Privacy

- Everything happens on this PC. No notification, title or text is sent anywhere.
- The history is kept in memory only, at most 100 notices and 24 hours, and is gone when NotNotch quits or live notices are switched off. Notification texts are never written to disk. The settings keep the names and ids of the apps that sent notices, so their rules can be set.
- App logos come from Windows; nothing is downloaded.
- The notnotch-notify channel is a named pipe that only your Windows account can open: its access list grants your user and nobody else, connections from other computers are refused, clients from another sign-in session are refused, and the pipe name includes your session and user id. NotNotch only opens the channel when no other program holds that name; if one does, the settings say the channel could not be opened. On its side, notnotch-notify sends nothing unless it can check that the program at the other end of the pipe runs under your account and at least at its own integrity level (so a sandboxed low-integrity program cannot pose as NotNotch), and it connects for identification only, so that program could not act as you even if it were someone else's.
- A notice's text is only ever shown as text; it is never run.
