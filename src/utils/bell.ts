// Bell notification utility — cross-platform audible alerts
import { exec } from 'child_process';
import { platform } from 'os';
import { existsSync } from 'fs';

const currentPlatform = platform();

type BellReason = 'permission' | 'done' | 'error';

interface BellOptions {
  /** Override env vars for testing */
  env?: Record<string, string | undefined>;
}

// Default system sounds per platform per reason
const DARWIN_SOUNDS: Record<BellReason, string> = {
  permission: '/System/Library/Sounds/Ping.aiff',
  done: '/System/Library/Sounds/Glass.aiff',
  error: '/System/Library/Sounds/Sosumi.aiff',
};

const LINUX_SOUNDS: Record<BellReason, string> = {
  permission: '/usr/share/sounds/freedesktop/stereo/bell.oga',
  done: '/usr/share/sounds/freedesktop/stereo/complete.oga',
  error: '/usr/share/sounds/freedesktop/stereo/dialog-error.oga',
};

const WIN_SOUNDS: Record<BellReason, string> = {
  permission: 'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  done: 'C:\\Windows\\Media\\Windows Notify Calendar.wav',
  error: 'C:\\Windows\\Media\\Windows Critical Stop.wav',
};

/** Try each command until one succeeds. Each command runs with 2>/dev/null. */
function tryPlay(commands: string[]): void {
  if (commands.length === 0) return;
  const [cmd, ...rest] = commands;
  // Use sh -c so 2>/dev/null works cross-shell on Linux/macOS
  const shellCmd =
    currentPlatform === 'win32' ? cmd : `sh -c '${cmd.replace(/'/g, "'\\''")}' 2>/dev/null`;
  exec(shellCmd, err => {
    if (err && rest.length > 0) {
      tryPlay(rest);
    }
  });
}

function playFile(filePath: string): void {
  if (!existsSync(filePath)) return;

  if (currentPlatform === 'darwin') {
    tryPlay([`afplay "${filePath}"`]);
  } else if (currentPlatform === 'linux') {
    // Try PipeWire first, then PulseAudio, then ALSA
    tryPlay([`pw-play "${filePath}"`, `paplay "${filePath}"`, `aplay "${filePath}"`]);
  } else if (currentPlatform === 'win32') {
    // PlaySync blocks — use a detached powershell
    exec(
      `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile (New-Object Media.SoundPlayer ''${filePath}'').PlaySync()' -WindowStyle Hidden"`,
      () => {} // fire-and-forget
    );
  }
}

export function playBell(reason: BellReason, opts?: BellOptions): void {
  const env = opts?.env ?? process.env;

  if (env.SPICA_BELL === 'false') return;

  // Custom sound file from env (overrides defaults)
  const envKey =
    reason === 'permission'
      ? 'SPICA_BELL_PERMISSION'
      : reason === 'done'
        ? 'SPICA_BELL_DONE'
        : 'SPICA_BELL_ERROR';

  const customSound = env[envKey];
  if (customSound && existsSync(customSound)) {
    playFile(customSound);
    return;
  }

  // Platform default sounds
  if (currentPlatform === 'darwin') {
    playFile(DARWIN_SOUNDS[reason]);
  } else if (currentPlatform === 'linux') {
    playFile(LINUX_SOUNDS[reason]);
  } else if (currentPlatform === 'win32') {
    playFile(WIN_SOUNDS[reason]);
  }
}

export function isBellEnabled(): boolean {
  return process.env.SPICA_BELL !== 'false';
}
