"""
Persistent watcher script for CODESYS IPC.

Runs inside CODESYS via --runscript on the primary (UI) thread.
Polls a commands/ directory and executes each command directly on the
primary thread (no marshalling). Yields to the IDE between polls via
``system.delay()``, which serves the message loop and keeps the UI
interactive.

Why no background thread? CODESYS V3.5 SP21+ removed
``system.execute_on_primary_thread()``, the API older versions of this
watcher used to marshal work from a .NET background thread back to the
UI thread. The single-thread design here works on SP19, SP21, and SP22+.

{IPC_BASE_DIR} is interpolated by Node.js before launch.
"""
import sys
import os
import time
import traceback
import json

# --- Configuration ---
IPC_BASE_DIR = r"{IPC_BASE_DIR}"
COMMANDS_DIR = os.path.join(IPC_BASE_DIR, "commands")
RESULTS_DIR = os.path.join(IPC_BASE_DIR, "results")
POLL_INTERVAL = 50  # milliseconds
WATCHER_VERSION = "0.4.1"

# --- Error capture file (written before anything else can fail) ---
_ERROR_FILE = os.path.join(IPC_BASE_DIR, "watcher_error.txt")

def _write_error(msg):
    try:
        with open(_ERROR_FILE, "a") as f:
            f.write("[%f] %s\n" % (time.time(), msg))
    except:
        pass

try:
    # --- Ensure directories exist ---
    if not os.path.exists(COMMANDS_DIR):
        os.makedirs(COMMANDS_DIR)
    if not os.path.exists(RESULTS_DIR):
        os.makedirs(RESULTS_DIR)

    # --- Atomic file write helper ---
    def atomic_write(file_path, content):
        tmp_path = file_path + ".tmp"
        with open(tmp_path, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        if os.path.exists(file_path):
            os.remove(file_path)
        os.rename(tmp_path, file_path)

    # --- Write ready signal EARLY ---
    ready_path = os.path.join(IPC_BASE_DIR, "ready.signal")
    info = {
        "version": WATCHER_VERSION,
        "python_version": sys.version,
        "platform": sys.platform,
        "ipc_dir": IPC_BASE_DIR,
        "timestamp": time.time(),
        "pid": os.getpid(),
    }
    atomic_write(ready_path, json.dumps(info, indent=2))
    print("[WATCHER] Ready signal written to %s" % ready_path)

    # --- Import scripting engine ---
    _write_error("About to import scriptengine")
    import scriptengine as se
    _write_error("scriptengine imported OK")

    # --- File-based logging ---
    _LOG_FILE = os.path.join(IPC_BASE_DIR, "watcher.log")

    def _log(msg):
        try:
            with open(_LOG_FILE, "a") as f:
                f.write("[%f] %s\n" % (time.time(), msg))
        except:
            pass

    # --- Output Capture ---
    class OutputCapture:
        def __init__(self):
            self._buffer = []
        def write(self, s):
            self._buffer.append(str(s))
        def writelines(self, lines):
            self._buffer.extend([str(l) for l in lines])
        def flush(self):
            pass
        def getvalue(self):
            return ''.join(self._buffer)

    def execute_script(script_code, request_id):
        """Execute script_code synchronously on the current (primary) thread.
        Returns the result dict to be written to results/."""
        success = False
        output = ""
        error = ""
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        capture = OutputCapture()
        sys.stdout = capture
        sys.stderr = capture
        try:
            exec_globals = {
                '__builtins__': __builtins__,
                'sys': sys,
                'os': os,
                'time': time,
                'traceback': traceback,
                'shutil': __import__('shutil'),
            }
            exec(script_code, exec_globals)
            output = capture.getvalue()
            if "SCRIPT_ERROR" in output:
                success = False
                error = "Script reported error via SCRIPT_ERROR marker"
            elif "SCRIPT_SUCCESS" in output:
                success = True
            else:
                success = True
        except SystemExit as e:
            output = capture.getvalue()
            exit_code = e.code
            if exit_code is None or exit_code == 0:
                success = True
                if "SCRIPT_ERROR" in output:
                    success = False
                    error = "Script reported error via SCRIPT_ERROR marker"
            elif isinstance(exit_code, int):
                if "SCRIPT_SUCCESS" in output and "SCRIPT_ERROR" not in output:
                    success = True
                else:
                    success = False
                    error = "Script exited with code %s" % exit_code
            elif isinstance(exit_code, str):
                success = False
                error = exit_code
        except KeyboardInterrupt:
            # User pressed "Cancel this operation" in CODESYS during this command.
            # Abort just this command; the watcher loop continues.
            output = capture.getvalue()
            error = "Aborted by user (Cancel pressed in CODESYS)"
            success = False
        except Exception as e:
            output = capture.getvalue()
            error = "%s: %s\n%s" % (type(e).__name__, str(e), traceback.format_exc())
            success = False
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr

        return {
            "requestId": request_id,
            "success": success,
            "output": output,
            "error": error,
            "timestamp": time.time(),
        }

    def process_command(command_file):
        """Process a single command file end-to-end on the primary thread."""
        command_path = os.path.join(COMMANDS_DIR, command_file)
        request_id = command_file.replace(".command.json", "")
        result_path = os.path.join(RESULTS_DIR, "%s.result.json" % request_id)

        _log("Processing command: %s" % request_id)

        try:
            with open(command_path, "r") as f:
                command_data = json.loads(f.read())
            script_path = command_data.get("scriptPath", "")
            if not os.path.exists(script_path):
                raise IOError("Script file not found: %s" % script_path)
            with open(script_path, "r") as f:
                script_code = f.read()
        except Exception as read_err:
            _log("Error reading command: %s" % read_err)
            atomic_write(result_path, json.dumps({
                "requestId": request_id,
                "success": False,
                "output": "",
                "error": "Read error: %s" % read_err,
                "timestamp": time.time(),
            }))
            _cleanup_command_files(command_path, request_id)
            return

        result = execute_script(script_code, request_id)
        atomic_write(result_path, json.dumps(result))
        _log("Result written: success=%s" % result.get("success"))

        _cleanup_command_files(command_path, request_id)

    def _cleanup_command_files(command_path, request_id):
        try:
            if os.path.exists(command_path):
                os.remove(command_path)
            sp = os.path.join(COMMANDS_DIR, "%s.py" % request_id)
            if os.path.exists(sp):
                os.remove(sp)
        except:
            pass

    def _terminate_requested():
        return os.path.exists(os.path.join(IPC_BASE_DIR, "terminate.signal"))

    # --- Main loop on the primary thread ---
    print("[WATCHER] Starting watcher v%s (single-thread, primary)" % WATCHER_VERSION)
    print("[WATCHER] IPC directory: %s" % IPC_BASE_DIR)
    print("[WATCHER] Python version: %s" % sys.version)
    _log("Watcher main loop entered")

    def _safe_delay(ms):
        """Yield via system.delay() but swallow KeyboardInterrupt.

        CODESYS injects KeyboardInterrupt into the script when the user
        clicks "Click here to CANCEL this operation" in the IDE. The
        watcher should keep running across that — only an explicit
        terminate.signal or process kill should stop it.
        """
        try:
            se.system.delay(ms)
        except KeyboardInterrupt:
            _log("KeyboardInterrupt during system.delay() — ignored, watcher continues")

    while True:
        try:
            if _terminate_requested():
                _log("Terminate signal received")
                print("[WATCHER] Terminate signal received, exiting")
                break

            cmd_files = sorted([
                f for f in os.listdir(COMMANDS_DIR)
                if f.endswith(".command.json")
            ])
            if cmd_files:
                process_command(cmd_files[0])
        except KeyboardInterrupt:
            _log("KeyboardInterrupt during loop iteration — ignored, watcher continues")
        except Exception as e:
            _log("Loop error: %s\n%s" % (e, traceback.format_exc()))

        # Yield: serves the message loop so the UI stays interactive.
        _safe_delay(POLL_INTERVAL)

    _log("Watcher main loop exited")

except KeyboardInterrupt:
    # Last-resort: a Cancel that fires before the loop is even reached
    # (e.g. during scriptengine import or directory setup) should still
    # exit quietly without the CODESYS exception dialog.
    _write_error("KeyboardInterrupt outside main loop — exiting quietly")
    print("[WATCHER] Cancelled by user before main loop; exiting.")
except Exception as _fatal:
    _write_error("FATAL: %s\n%s" % (_fatal, traceback.format_exc()))
    print("[WATCHER] FATAL ERROR: %s" % _fatal)
    traceback.print_exc()
