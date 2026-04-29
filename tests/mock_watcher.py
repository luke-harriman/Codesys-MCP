"""
Mock watcher for testing the IPC mechanism without CODESYS.
Simulates the persistent watcher by polling commands/ and executing scripts via exec().
"""
import sys
import os
import time
import json
import traceback
import argparse


class OutputCapture:
    """Capture stdout/stderr for script execution."""
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


def atomic_write(file_path, content):
    """Write to .tmp then rename for atomic file creation."""
    tmp_path = file_path + ".tmp"
    with open(tmp_path, "w") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    if os.path.exists(file_path):
        os.remove(file_path)
    os.rename(tmp_path, file_path)


def read_with_retry(path, attempts=10, delay=0.02):
    """Read a file with retries on PermissionError.

    On Windows the renamed file can be briefly locked by Defender / NTFS
    finalization, producing a transient PermissionError. Retry a few times
    with a small sleep before giving up.
    """
    last = None
    for _ in range(attempts):
        try:
            with open(path, "r") as f:
                return f.read()
        except (IOError, OSError) as e:
            # PermissionError is OSError on py3, IOError on py2
            last = e
            time.sleep(delay)
    raise last


def process_command(commands_dir, results_dir, command_file):
    """Process a single .command.json file."""
    command_path = os.path.join(commands_dir, command_file)
    request_id = command_file.replace(".command.json", "")
    result_path = os.path.join(results_dir, "%s.result.json" % request_id)

    success = False
    output = ""
    error = ""

    try:
        command_data = json.loads(read_with_retry(command_path))

        script_path = command_data.get("scriptPath", "")

        if not os.path.exists(script_path):
            raise IOError("Script file not found: %s" % script_path)

        script_code = read_with_retry(script_path)

        # Capture stdout/stderr
        old_stdout = sys.stdout
        old_stderr = sys.stderr
        capture = OutputCapture()
        sys.stdout = capture
        sys.stderr = capture

        try:
            # Fresh globals dict for namespace isolation
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

        except Exception as e:
            output = capture.getvalue()
            error = "%s: %s\n%s" % (type(e).__name__, str(e), traceback.format_exc())
            success = False

        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr

    except Exception as outer_err:
        error = "Mock watcher error: %s\n%s" % (str(outer_err), traceback.format_exc())
        success = False

    result_data = {
        "requestId": request_id,
        "success": success,
        "output": output,
        "error": error,
        "timestamp": time.time(),
    }
    try:
        atomic_write(result_path, json.dumps(result_data))
    except Exception as write_err:
        sys.stderr.write("ERROR writing result: %s\n" % write_err)

    # Clean up
    try:
        if os.path.exists(command_path):
            os.remove(command_path)
        script_file = os.path.join(commands_dir, "%s.py" % request_id)
        if os.path.exists(script_file):
            os.remove(script_file)
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser(description="Mock CODESYS watcher for testing")
    parser.add_argument("--ipc-dir", required=True, help="IPC base directory")
    args = parser.parse_args()

    ipc_dir = args.ipc_dir
    commands_dir = os.path.join(ipc_dir, "commands")
    results_dir = os.path.join(ipc_dir, "results")

    os.makedirs(commands_dir, exist_ok=True)
    os.makedirs(results_dir, exist_ok=True)

    # Write ready signal
    ready_path = os.path.join(ipc_dir, "ready.signal")
    atomic_write(ready_path, json.dumps({
        "version": "mock-0.1.0",
        "python_version": sys.version,
        "platform": sys.platform,
        "ipc_dir": ipc_dir,
        "timestamp": time.time(),
        "pid": os.getpid(),
    }))

    # Main loop
    try:
        while True:
            # Check terminate
            if os.path.exists(os.path.join(ipc_dir, "terminate.signal")):
                break

            try:
                command_files = sorted([
                    f for f in os.listdir(commands_dir)
                    if f.endswith(".command.json")
                ])
                if command_files:
                    process_command(commands_dir, results_dir, command_files[0])
            except Exception as e:
                sys.stderr.write("Scan error: %s\n" % e)

            time.sleep(0.05)

    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
