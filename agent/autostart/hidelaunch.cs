// hidelaunch - start a console program with no window, and stay until it ends.
//
// WHY THIS EXISTS. The logon task has to start node with no console window on
// the owner's desktop. The three obvious ways are all out:
//   - node.exe as the task action shows a window. MEASURED 2026-09-23: a
//     terminal window titled "C:\Program Files\nodejs\node.exe" appears ~130ms
//     in and disappears when node is killed. On Windows 11 that window belongs
//     to the WindowsTerminal PROCESS, not to node, so a check that only looks
//     at node's own windows reports "no window" and is wrong.
//   - wscript //B a .vbs - Microsoft is disabling VBScript by default and then
//     removing it.
//   - conhost.exe --headless - what this replaces. It works, but the flag is
//     undocumented (conhost /? prints nothing), it swallows the child's exit
//     code, and conhost --headless as the parent of cmd.exe is a catalogued
//     attacker technique with public Sigma and Splunk detections written
//     against exactly that shape. Fine on one's own PC; this ships to other
//     people's machines. (r/PowerShell, 2026-09-23.)
//
// /target:winexe puts this in the GUI subsystem, so Windows gives IT no
// console, and CREATE_NO_WINDOW gives the child none either.
//
// IT WAITS FOR THE CHILD, and that is load-bearing, not tidiness. The task's
// crash recovery is an every-minute clock trigger plus IgnoreNew: the trigger
// is a no-op while the task is RUNNING and a restart once it is READY. A
// launcher that spawned node and exited would put the task back to Ready in
// milliseconds, and the trigger would start a SECOND agent a minute later, and
// another the minute after that. Staying alive until the child exits is what
// makes the task's state mean "the agent is up", exactly as conhost did.
//
// It also returns the child's exit code, which conhost --headless does not
// (measured: conhost --headless cmd /c exit 42 returns 0), so the task's Last
// Run Result says something true again.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class HideLaunch {
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint INFINITE = 0xFFFFFFFF;
    const uint WAIT_OBJECT_0 = 0x00000000;
    // Exit codes of our own, high enough not to collide with a plausible child
    // code, and reported so the task's Last Run Result names the failure.
    const int E_WAIT_FAILED = 0x2001;
    const int E_NO_EXIT_CODE = 0x2002;
    // Not 2: CreateProcess failure below returns the Win32 error, and 2 there
    // is ERROR_FILE_NOT_FOUND - "the program named does not exist" and "no
    // command was given" are different repairs and must not share a code.
    const int E_NO_COMMAND = 0x2003;

    // CharSet.Unicode, not the default Ansi: the call is CreateProcessW, so
    // lpReserved/lpDesktop/lpTitle must marshal as LPWSTR. All three are null
    // today, which is the only reason Ansi has not bitten - set lpDesktop to
    // pin a window station and CreateProcessW would read an ANSI pointer as
    // UTF-16 and fail with nothing to point at.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    // lpCommandLine is a StringBuilder, NOT a string: CreateProcessW is
    // documented to WRITE INTO that buffer, and a managed string is pinned
    // straight from the GC heap. Nothing misbehaves today, because the buffer
    // is never read after the call - but the next edit that logs or retries
    // with it would be reading a corrupted string.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessW(string app, StringBuilder cmdline, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetCommandLineW();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint ms);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    // Everything after this program's own name on the RAW command line.
    //
    // NOT the parsed args rejoined with spaces: that drops every quote, and the
    // command carries paths with spaces ("C:\Program Files\nodejs\node.exe").
    // The first draft did exactly that and cmd answered 'C:\Program' is not
    // recognized as an internal or external command (measured 2026-09-23).
    internal static string Remainder(string raw) {
        if (raw == null) return "";
        int i = 0;
        while (i < raw.Length && (raw[i] == ' ' || raw[i] == '\t')) i++;
        if (i < raw.Length && raw[i] == '"') {
            i++;
            while (i < raw.Length && raw[i] != '"') i++;
            if (i < raw.Length) i++;            // the closing quote
        } else {
            while (i < raw.Length && raw[i] != ' ' && raw[i] != '\t') i++;
        }
        while (i < raw.Length && (raw[i] == ' ' || raw[i] == '\t')) i++;
        return raw.Substring(i);
    }

    static int Main() {
        string cmdline = Remainder(Marshal.PtrToStringUni(GetCommandLineW()));
        if (cmdline.Length == 0) return E_NO_COMMAND;

        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        PROCESS_INFORMATION pi;

        // lpApplicationName null: the command line names the program, so a
        // caller can hand over a full "cmd.exe /s /c ..." line unchanged.
        //
        // THE FIRST TOKEN MUST BE QUOTED OR FREE OF SPACES. With a null
        // application name Windows resolves it itself, searching this exe's
        // own directory and the current directory BEFORE System32, and
        // prefix-scanning an unquoted spaced path (C:\Program.exe before
        // C:\Program Files\...). The caller in this repo passes a full quoted
        // path from $env:ComSpec for exactly those two reasons.
        if (!CreateProcessW(null, new StringBuilder(cmdline, cmdline.Length + 1),
                            IntPtr.Zero, IntPtr.Zero,
                            false, CREATE_NO_WINDOW, IntPtr.Zero, null, ref si, out pi)) {
            // A Win32 error is a useful Last Run Result; 1 would not be.
            return Marshal.GetLastWin32Error();
        }

        CloseHandle(pi.hThread);

        // A FAILED WAIT MUST NOT LOOK LIKE A CLEAN EXIT. On WAIT_FAILED the
        // child is still alive, GetExitCodeProcess hands back STILL_ACTIVE
        // (259), and reporting that as the exit code would leave the task
        // READY with node running - the every-minute trigger then starts a
        // SECOND agent, the exact failure the wait exists to prevent, while
        // reporting a plausible-looking code.
        uint waited = WaitForSingleObject(pi.hProcess, INFINITE);
        if (waited != WAIT_OBJECT_0) {
            CloseHandle(pi.hProcess);
            return E_WAIT_FAILED;
        }

        // Only AFTER a successful wait, so 259 here is a real exit code from a
        // process that has genuinely exited - not STILL_ACTIVE. Rejecting 259
        // unconditionally would misreport a child that legitimately exits 259.
        uint code;
        if (!GetExitCodeProcess(pi.hProcess, out code)) {
            CloseHandle(pi.hProcess);
            return E_NO_EXIT_CODE;
        }
        CloseHandle(pi.hProcess);
        return unchecked((int)code);
    }
}
