import { useEffect, useRef } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { nav } from "../../notch/nav";
import { keyboardFocus } from "../../platform/native";
import { settings } from "../../settings/store";
import { t } from "../../i18n";
import { attachTerminal, endSession, focusTerminal, start } from "./session";

/**
 * PowerShell in the notch. Opening by hover leaves the keyboard with the app in front;
 * the window takes it on a click into the terminal, or right away when the shortcut
 * or tray opened the notch (Notch.tsx). Closing gives it back (keyboard_focus in lib.rs).
 */
export function TerminalView() {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let detach: (() => void) | null = null;
    let gone = false;
    void attachTerminal(box.current!).then((d) => (gone ? d() : (detach = d)));
    return () => {
      gone = true;
      detach?.();
      // Still on this tool while unmounting = the notch closed (a tool switch changes the tab first).
      if (settings.get().terminal.endOnClose && nav.get().tabId === "terminal") endSession();
    };
  }, []);

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <HeaderActions>
        <HeaderButton
          label={t("Neue Sitzung")}
          onClick={() => {
            void start();
            focusTerminal();
          }}
        >
          <ArrowClockwise size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>
      {/* No click bubbling: a triple click selects a line here, on the notch it would toggle focus mode. */}
      <div
        // A shell is left to right in any language.
        dir="ltr"
        // Dark in every theme: the shell's colours (session.ts) are made for a dark ground.
        className="min-h-0 flex-1 rounded-[12px] bg-[#1c1c1e] py-2 pl-3 pr-1"
        onPointerDown={() => {
          keyboardFocus(true);
          focusTerminal();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* xterm 6 draws its own slider (theme in session.ts); its viewport would add the white system scrollbar beside it. */}
        <div ref={box} className="h-full w-full [&_.xterm-viewport]:[scrollbar-width:none]" />
      </div>
    </div>
  );
}
