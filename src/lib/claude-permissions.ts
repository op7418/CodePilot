export const DANGEROUSLY_SKIP_PERMISSIONS_UNSUPPORTED_CODE = 'DANGEROUSLY_SKIP_PERMISSIONS_ROOT_UNSUPPORTED' as const;

export interface DangerousSkipPermissionsSupport {
  supported: boolean;
  reasonCode?: typeof DANGEROUSLY_SKIP_PERMISSIONS_UNSUPPORTED_CODE;
  reason?: string;
}

interface DangerousSkipPermissionsSupportOptions {
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
}

export function getDangerouslySkipPermissionsSupport(
  options: DangerousSkipPermissionsSupportOptions = {},
): DangerousSkipPermissionsSupport {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined);

  if (platform === 'win32') {
    return { supported: true };
  }

  if (uid !== 0) {
    return { supported: true };
  }

  if (env.IS_SANDBOX === '1' || env.CLAUDE_CODE_BUBBLEWRAP === '1') {
    return { supported: true };
  }

  return {
    supported: false,
    reasonCode: DANGEROUSLY_SKIP_PERMISSIONS_UNSUPPORTED_CODE,
    reason: 'Auto-approve is unavailable when CodePilot runs as root/sudo. Run the app as a regular user to enable it.',
  };
}

export function isDangerouslySkipPermissionsSupported(
  options: DangerousSkipPermissionsSupportOptions = {},
): boolean {
  return getDangerouslySkipPermissionsSupport(options).supported;
}
