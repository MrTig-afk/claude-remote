import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Windows has no drive enumeration in Node, and wmic is gone on Windows 11
// 24H2+, so one PowerShell call per request is the only route left.
export const DRIVE_QUERY_ARGS = Object.freeze([
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,VolumeName | ConvertTo-Json -Compress",
]);

const execFileAsync = promisify(execFile);

// Same posture as defaultPidImageName in sessions.js: windowsHide so no
// console flashes on the owner's desktop, a hard timeout so a wedged CIM call
// cannot hold the request open, and a swallow at the call site rather than a
// throw out of the module.
async function defaultDriveExec(args) {
  const { stdout } = await execFileAsync('powershell.exe', args, {
    windowsHide: true,
    timeout: 5000,
  });
  return stdout;
}

/**
 * "C:" - one uppercase A-Z, one colon, no trailing separator, no slash.
 * Win32_LogicalDisk's DeviceID is already in this form; this is defence
 * against a shape change, not a transformation the happy path needs.
 */
function normaliseLetter(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  if (!/^[A-Za-z]:$/.test(trimmed)) return null;
  return trimmed[0].toUpperCase() + ':';
}

/**
 * A non-empty string for the picker to render without a branch: a real
 * trimmed VolumeName, or the drive letter itself when the volume has none
 * (common, and there is no invented English string to translate here).
 */
function labelFor(volumeName, letter) {
  if (typeof volumeName === 'string' && volumeName.trim() !== '') return volumeName.trim();
  return letter;
}

export async function listDrives(ctx = {}) {
  const {
    driveExec = defaultDriveExec,
    systemDrive = process.env.SystemDrive,
  } = ctx;

  let stdout;
  try {
    stdout = await driveExec(DRIVE_QUERY_ARGS);
  } catch {
    return { drives: [], error: 'unavailable' };
  }

  const trimmed = stdout.trim();
  let rows;
  if (trimmed === '') {
    // PS 5.1 emits nothing for an empty pipeline - zero rows, not a failure.
    rows = [];
  } else {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { drives: [], error: 'unavailable' };
    }
    if (parsed === null) {
      // PS 7 / $null pipeline - also zero rows, not a failure.
      rows = [];
    } else if (Array.isArray(parsed)) {
      rows = parsed;
    } else if (typeof parsed === 'object') {
      // Exactly one fixed drive - ConvertTo-Json drops the array wrapper.
      rows = [parsed];
    } else {
      // A scalar (number/string/boolean) after a non-empty body is not a
      // shape this command ever legitimately produces.
      return { drives: [], error: 'unavailable' };
    }
  }

  const blockedLetter = normaliseLetter(systemDrive) || 'C:';

  const drives = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const letter = normaliseLetter(row.DeviceID);
    if (letter === null) continue;
    const entry = { letter, label: labelFor(row.VolumeName, letter), blocked: letter === blockedLetter };
    if (entry.blocked) entry.reason = 'system';
    drives.push(entry);
  }

  drives.sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));

  return { drives };
}
