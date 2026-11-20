import { ChildProcess, execFile, execSync } from 'child_process';
import { dialog } from 'electron';
import { ArrayExt } from '@lumino/algorithm';
import log from 'electron-log';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { IDisposable } from './tokens';
import { getFreePort, getUserDataDir } from './utils';

export const SERVER_TOKEN_PREFIX = 'jlab:srvr:';
import {
  EngineType,
  KeyValueMap,
  resolveWorkingDirectory,
  SettingType,
  userSettings,
  WorkspaceSettings
} from './config/settings';
import { createHash, randomBytes } from 'crypto';
import { ProgressView } from './progressview/progressview';
import {
  ContainerConfigParser,
  PlatformType,
  VariableContext
} from './config/containerConfigParser';
import { getDefaultStorageDirectory } from './config/storageMount';
import { requireContainerEntry } from './config/catalogInstance';

export { getDefaultStorageDirectory } from './config/storageMount';

const SERVER_LAUNCH_TIMEOUT = 40 * 60000; // milliseconds
const JUPYTER_STARTUP_TIMEOUT = 10 * 60000; // 10 min for Jupyter to start after container is up
const SERVER_RESTART_LIMIT = 1; // max server restarts

function waitForDeadline(deadline: { value: number }): Promise<boolean> {
  return new Promise(resolve => {
    const check = () => {
      if (Date.now() >= deadline.value) {
        resolve(false);
      } else {
        setTimeout(check, 1000);
      }
    };
    check();
  });
}

function createTempFile(
  fileName = 'temp',
  data = '',
  encoding: BufferEncoding = 'utf8'
) {
  const tempDirPath = path.join(os.tmpdir(), 'neurodesk_app');
  const tmpDir = fs.mkdtempSync(tempDirPath);
  const tmpFilePath = path.join(tmpDir, fileName);

  fs.writeFileSync(tmpFilePath, data, { encoding });

  return tmpFilePath;
}

export interface INfsMountInfo {
  server: string;
  exportPath: string;
  nfsVersion: string;
  mountPoint: string;
}

function getLinuxFileSystemType(directory: string): string {
  if (process.platform !== 'linux') {
    return '';
  }

  try {
    // Use /proc/mounts instead of stat -f which can hang on NFS mounts
    const mounts = fs.readFileSync('/proc/mounts', 'utf8');
    let bestMatch = '';
    let bestFsType = '';
    for (const line of mounts.split('\n')) {
      const parts = line.split(' ');
      if (parts.length >= 3 && directory.startsWith(parts[1])) {
        if (parts[1].length > bestMatch.length) {
          bestMatch = parts[1];
          bestFsType = parts[2];
        }
      }
    }
    return bestFsType.toLowerCase();
  } catch (error) {
    log.warn(`Failed to determine filesystem type for ${directory}: ${error}`);
    return '';
  }
}

export interface ILaunchScriptParams {
  /** Loaded container configuration — the single source of the launch args. */
  parser: ContainerConfigParser;
  engineType: EngineType;
  /** Node platform string: 'win32' | 'darwin' | 'linux'. */
  platform: string;
  port: number;
  token: string;
  cvmfsMode: string;
  /** Host OS version (Ubuntu YYMM); empty when unknown. */
  osVersion: string;
  tinyrangePath: string;
  /** Name already scoped to the host user, when resolved by createLaunchScript. */
  containerName?: string;
  /**
   * Several host users share this container engine. Switches the container
   * from the legacy fixed MAC (and Podman IP) to a per-user MAC.
   */
  sharedHost?: boolean;
  /** Explicit container MAC address; overrides the sharedHost default. */
  macAddress?: string;
  /** Host directory mounted at the configured storage mount. */
  storageDirectory?: string;
  /** Host directory mounted at /data, if the user configured one. */
  additionalDirectory?: string;
  isNfsAdditionalDirectory?: boolean;
  overrideDefaultServerArgs?: boolean;
}

/**
 * The host user's identity, shared by everything scoped to one user (container
 * name and MAC address) so they always agree:
 * the numeric UID on Unix, the account name on Windows.
 */
export function currentUserId(): string | number {
  return process.getuid?.() ?? os.userInfo().username;
}

/** User ID made safe for Docker object names. */
export function userSuffix(userId: string | number): string {
  return String(userId).replace(/[^a-zA-Z0-9_.-]/g, '-');
}

/** Keep a stable container name for each host user across app restarts. */
export function getUserScopedContainerName(
  name: string,
  userId: string | number = currentUserId()
): string {
  return `${name}-${userSuffix(userId)}`;
}

/**
 * MAC address every container used before shared-host support. It is pinned
 * so MATLAB, which binds its activation to the MAC, does not ask to be
 * reactivated each time the container is re-created (see the Neurodesk FAQ).
 * Single-user hosts keep it so existing activations stay valid.
 */
export const LEGACY_MAC_ADDRESS = '88:75:56:ef:3e:d6';

/** Static Podman bridge IP used alongside the legacy MAC on single-user hosts. */
export const LEGACY_PODMAN_IP = '10.88.0.10';

const MAC_PREFIX = '88:75:56';
const LEGACY_MAC_SUFFIX = 0xef3ed6;

/**
 * Stable, per-user container MAC address, used only on shared hosts.
 *
 * The MAC stays fixed across restarts (MATLAB activation keeps working), but
 * differs between host users: containers sharing a MAC on the same bridge
 * confuse the bridge's forwarding table, so a second user's container becomes
 * unreachable through its published port and the app hangs at startup.
 *
 * The last three bytes are the low 24 bits of a numeric UID (no collisions
 * between UIDs less than 2^24 apart, which covers local and most directory
 * UIDs), or the first three bytes of a SHA-256 of a Windows account name.
 * The one value that would reproduce the legacy MAC is bumped by one, so a
 * shared-host container can never collide with a single-user one.
 */
export function getUserScopedMacAddress(
  userId: string | number = currentUserId()
): string {
  const id = String(userId);
  let suffix = /^\d+$/.test(id)
    ? Number(id) & 0xffffff
    : createHash('sha256').update(id).digest().readUIntBE(0, 3);
  if (suffix === LEGACY_MAC_SUFFIX) {
    suffix = (suffix + 1) & 0xffffff;
  }
  const hex = suffix.toString(16).padStart(6, '0');
  return `${MAC_PREFIX}:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4)}`;
}

/**
 * One shell command that prints one line per running container:
 * `<name> <mac> [<mac>...]` (one MAC per attached network).
 */
export function buildSharedHostProbeCommand(
  engineType: EngineType,
  platform: string = process.platform
): string {
  const inspectFormat =
    '{{.Name}}{{range .NetworkSettings.Networks}} {{.MacAddress}}{{end}}';
  if (platform === 'win32') {
    return `for /f %i in ('${engineType} ps -q') do @${engineType} inspect -f "${inspectFormat}" %i`;
  }
  return (
    `ids=$(${engineType} ps -q); ` +
    `[ -z "$ids" ] || ${engineType} inspect -f '${inspectFormat}' $ids`
  );
}

/**
 * True when a running container other than this user's own already uses the
 * legacy MAC, i.e. another host user's Neurodesk container (from this or an
 * older app version) is up on the same engine. Starting a second container
 * with the same MAC would make one of them unreachable.
 */
export function parseSharedHostProbe(
  output: string,
  ownContainerName: string
): boolean {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => {
      const [rawName, ...macs] = line.split(/\s+/);
      const name = rawName.replace(/^\//, '');
      return (
        name !== ownContainerName &&
        macs.some(mac => mac.toLowerCase() === LEGACY_MAC_ADDRESS)
      );
    });
}

/**
 * Detect whether another host user's container already holds the legacy MAC.
 * Rootless Docker/Podman give each user their own daemon and network, so
 * other users' containers are invisible there and cannot collide anyway.
 * Any failure or timeout falls back to single-user, which keeps the
 * pre-existing launch flags.
 */
export function detectSharedHost(
  engineType: EngineType,
  ownContainerName: string,
  platform: string = process.platform
): boolean {
  if (engineType === EngineType.TinyRange) {
    return false;
  }
  try {
    const output = execSync(buildSharedHostProbeCommand(engineType, platform), {
      encoding: 'utf-8',
      timeout: 5000
    });
    return parseSharedHostProbe(output, ownContainerName);
  } catch (error) {
    log.warn(`Shared-host detection failed, assuming single user: ${error}`);
    return false;
  }
}

/** Resolve the user-scoped name and remove any existing container with it. */
export function resolveContainerName(
  engineType: EngineType,
  name: string,
  userId?: string | number
): string {
  const containerName = getUserScopedContainerName(name, userId);
  const isTinyRange = engineType === EngineType.TinyRange;
  if (isTinyRange) {
    return containerName;
  }

  // Always remove any existing container with the name
  const isLinux = process.platform === 'linux';
  const rmCmd =
    process.platform === 'win32'
      ? `${engineType} rm -f ${containerName} >NUL 2>&1`
      : `${
          isLinux ? 'timeout 30 ' : ''
        }${engineType} rm -f ${containerName} &>/dev/null`;
  try {
    execSync(rmCmd, { encoding: 'utf-8', timeout: 35000 });
  } catch {
    // Container doesn't exist, rm failed, or timed out — proceed
    log.error(
      `Failed to remove existing container with name ${containerName} (it may not exist): ${engineType} rm -f ${containerName}`
    );
  }
  return containerName;
}

/**
 * Pure function that generates the launch script content.
 *
 * Every run flag, the image reference and the server args come from
 * baseContainerConfig.yml via ContainerConfigParser.buildLaunchArgs — this
 * function only wraps the resulting command in the engine lifecycle
 * scaffolding (image check, pull, stale container removal, log follow).
 *
 * Exported for testing.
 */
export function generateLaunchScript(params: ILaunchScriptParams): string {
  const {
    parser,
    engineType,
    platform,
    port,
    token,
    cvmfsMode,
    osVersion,
    tinyrangePath,
    containerName: resolvedContainerName,
    sharedHost = false,
    macAddress: requestedMacAddress,
    storageDirectory,
    additionalDirectory = '',
    isNfsAdditionalDirectory = false,
    overrideDefaultServerArgs = false
  } = params;

  const isWin = platform === 'win32';
  const isLinux = platform === 'linux';
  const platformType: PlatformType = isWin ? 'windows' : 'unix';
  const isTinyRange = engineType === EngineType.TinyRange;
  const isPodman = engineType === EngineType.Podman;
  const strPort = port.toString();

  const imageName = parser.getImageName();
  const storageMount = parser.getDefaultStorageMount();
  // Use the same name in --name and every lifecycle command.
  const containerName =
    resolvedContainerName ||
    getUserScopedContainerName(parser.getContainerName());
  const volumeMount = parser.getVolumeMount();

  // Keep path separators forward-slashed so the generated script is identical
  // no matter which OS generates it (the Windows tests run on Linux).
  const resolvedStorageDirectory =
    storageDirectory || getDefaultStorageDirectory(platform, storageMount);
  const storageDir = isWin
    ? resolvedStorageDirectory.replace(/\\/g, '//')
    : resolvedStorageDirectory;
  const buildDir = `${storageDir}/build`;
  const additionalDir = isWin
    ? additionalDirectory.replace(/\\/g, '/')
    : additionalDirectory;

  // Docker and Podman publish the host port onto the container's fixed
  // Jupyter port; TinyRange forwards the host port and serves on it directly.
  const serverPort = isTinyRange ? strPort : parser.getContainerPort();

  // Single-user hosts keep the legacy fixed MAC/IP so existing MATLAB
  // activations survive the upgrade. Shared hosts need a distinct MAC per user
  // and must let Podman assign the IP, or the second user's container is
  // unreachable (Docker) or fails to start (Podman).
  const macAddress =
    requestedMacAddress ||
    (sharedHost ? getUserScopedMacAddress() : LEGACY_MAC_ADDRESS);
  const podmanNetworkOpts = sharedHost
    ? `mac=${macAddress}`
    : `ip=${LEGACY_PODMAN_IP},mac=${macAddress}`;

  const context: VariableContext = {
    port: strPort,
    serverPort,
    token,
    cvmfsDisable: cvmfsMode,
    tinyrangePath,
    containerName,
    buildDir,
    storageDir,
    additionalDir,
    volumeMount,
    macAddress,
    podmanNetworkOpts
  };

  const launchCmd = parser
    .buildLaunchArgs(engineType, context, {
      platform: platformType,
      osVersion,
      additionalDir,
      includeServerArgs: !overrideDefaultServerArgs
    })
    .filter(arg => arg !== '')
    .join(' ');

  const volumeCheck = isWin
    ? `${engineType} volume inspect ${volumeMount} >NUL 2>&1 || ${engineType} volume create ${volumeMount}`
    : `${engineType} volume exists ${volumeMount} &> /dev/null || ${engineType} volume create ${volumeMount}`;
  const volumeCreate = isPodman ? volumeCheck : '';

  // Fix ownership of /home/jovyan on the persistent volume before launching.
  // The volume may have .cache or other dirs owned by root from a previous run
  // (e.g. when --user=root processes create files before the entrypoint chowns).
  // This prevents "Permission denied" errors like: mkdir: cannot create directory '/home/jovyan/.cache/run-one'
  // This runs in a separate container (no FUSE/CVMFS active), so chown -R is safe.
  const fixPermissionsCmd = isTinyRange
    ? ''
    : isWin
    ? `${engineType} run --rm --entrypoint chown -v ${volumeMount}:/home/jovyan ${imageName} -R 1000:100 /home/jovyan >NUL 2>NUL`
    : `${engineType} run --rm --entrypoint chown -v ${volumeMount}:/home/jovyan ${imageName} -R "$(id -u):100" /home/jovyan 2>/dev/null || true`;

  const removeCmd = isWin
    ? `${engineType} container exists ${containerName} >NUL 2>&1 && ${engineType} rm -f ${containerName} >NUL 2>&1`
    : `${engineType} container exists ${containerName} &> /dev/null && ${
        isLinux ? 'timeout 30 ' : ''
      }${engineType} rm -f ${containerName} &> /dev/null`;
  const stopCmd = isPodman
    ? removeCmd
    : isTinyRange
    ? ''
    : isWin
    ? `${engineType} rm -f ${containerName} >NUL 2>&1`
    : `${
        isLinux ? 'timeout 30 ' : ''
      }${engineType} rm -f ${containerName} &> /dev/null`;

  let script: string;

  // Resolve HOST_GATEWAY_IP: use 'host-gateway' if supported, otherwise resolve the actual IP.
  // Podman only added 'host-gateway' support in v4.1.0.
  // On macOS/Windows, Podman runs in a VM so host-gateway does not reliably resolve to the host.
  // We always resolve the actual gateway IP for Podman on macOS/Windows.
  const hostGatewayResolveWin = isTinyRange
    ? ''
    : `
        SET HOST_GATEWAY_IP=host-gateway
        ${
          isPodman
            ? `REM Windows: Podman runs in a VM, host-gateway does not reliably resolve to the Windows host
        REM Use PowerShell Get-NetRoute (locale-independent) to find the IPv4 default gateway
        FOR /F "delims=" %%i IN ('powershell -NoProfile -Command "try{(Get-NetRoute -DestinationPrefix 0.0.0.0/0 -ErrorAction Stop)[0].NextHop}catch{}"') DO SET HOST_GATEWAY_IP=%%i`
            : ''
        }`;

  const hostGatewayResolveUnix = isTinyRange
    ? ''
    : `
        HOST_GATEWAY_IP="host-gateway"
        ${
          isPodman
            ? isLinux
              ? `PODMAN_VER=$(${engineType} --version 2>/dev/null | awk '{print $3}')
        PODMAN_MAJOR=$(echo "$PODMAN_VER" | cut -d. -f1)
        PODMAN_MINOR=$(echo "$PODMAN_VER" | cut -d. -f2)
        if [ "$PODMAN_MAJOR" -lt 4 ] 2>/dev/null || { [ "$PODMAN_MAJOR" -eq 4 ] && [ "$PODMAN_MINOR" -lt 1 ]; } 2>/dev/null; then
          HOST_GATEWAY_IP=$(ip route | grep default | awk '{print $3}' | head -1)
          echo "[neurodesk-app] Podman $PODMAN_VER does not support host-gateway, using resolved IP: $HOST_GATEWAY_IP"
        fi`
              : `# macOS: Podman runs in a VM, host-gateway does not reliably resolve to the macOS host
        HOST_GATEWAY_IP=$(route -n get default 2>/dev/null | awk '/gateway:/{print $2}')
        [ -z "$HOST_GATEWAY_IP" ] && HOST_GATEWAY_IP="host-gateway"
        echo "[neurodesk-app] macOS Podman: using resolved gateway IP: $HOST_GATEWAY_IP"`
            : ''
        }`;

  if (isWin) {
    if (isTinyRange) {
      script = `
        setlocal enabledelayedexpansion
        ${launchCmd}
      `;
    } else {
      script = `
        setlocal enabledelayedexpansion
        SET ERRORCODE=0
        SET IMAGE_EXISTS=
        ${hostGatewayResolveWin}
        where ${engineType} >nul 2>nul
          if %ERRORLEVEL% neq 0 (
              echo "${engineType} command not found, running ${launchCmd}"
              ${launchCmd}
          )
        FOR /F "usebackq delims=" %%i IN (\`${engineType} image inspect ${imageName} --format="exists" 2^>nul\`) DO SET IMAGE_EXISTS=%%i
        ${fixPermissionsCmd}
        if "%IMAGE_EXISTS%"=="exists" (
            echo "Image exists. Starting container..."
            FOR /F "usebackq delims=" %%i IN (\`${engineType} container inspect -f "{{.State.Status}}" ${containerName}\`) DO SET CONTAINER_STATUS=%%i
              ${stopCmd}
              ${volumeCreate}
              ${launchCmd}
        ) else (
            echo "Image does not exist. Start downloading..."
            ${stopCmd}
            ${volumeCreate}
            ${engineType} pull ${imageName}
            ${launchCmd}
        )
        ${engineType} logs -f ${containerName}
      `;
    }
  } else {
    if (isTinyRange) {
      script = `
        umask 000
        ${launchCmd}
        `;
    } else {
      script = `
        ${hostGatewayResolveUnix}
        echo $HOST_GATEWAY_IP
        echo "[neurodesk-app] Launch script started at $(date -Iseconds)"
        echo "[neurodesk-app] Engine: ${engineType}"
        echo "[neurodesk-app] Image: ${imageName}"
        echo "[neurodesk-app] Additional directory: ${additionalDir || 'none'}"
        echo "[neurodesk-app] NFS additional directory: ${isNfsAdditionalDirectory}"
        echo "[neurodesk-app] Container name: ${containerName}"
        echo "[neurodesk-app] Port: ${strPort}"
        ${
          additionalDir
            ? `echo "[neurodesk-app] Additional dir mount info: $(mount | grep '${additionalDir
                .split('/')
                .slice(0, 3)
                .join('/')}' 2>/dev/null || echo 'no mount found')"`
            : ''
        }
        ${
          additionalDir
            ? `echo "[neurodesk-app] Additional dir accessible: $(ls -ld '${additionalDir}' 2>&1)"`
            : ''
        }
        ${
          isNfsAdditionalDirectory && additionalDir
            ? `
        if ! timeout 5 ls -ld '${additionalDir}' &>/dev/null; then
          echo "[neurodesk-app] ERROR: Additional directory not accessible (NFS mount may be stale)" >&2
          exit 1
        fi
        echo "[neurodesk-app] NFS mount check passed for ${additionalDir}"
        `
            : ''
        }
        if [[ "$(${engineType} image inspect ${imageName} --format='exists' 2> /dev/null)" == "exists" ]]; then
          ${stopCmd}
          ${volumeCreate}
          ${fixPermissionsCmd}
          CONTAINER_ID=$(${isLinux ? 'timeout 300 ' : ''}${launchCmd})
          LAUNCH_EXIT=$?
        else
          ${stopCmd}
          ${volumeCreate}
          ${isLinux ? 'timeout 300 ' : ''}${engineType} pull ${imageName}
          ${fixPermissionsCmd}
          CONTAINER_ID=$(${isLinux ? 'timeout 300 ' : ''}${launchCmd})
          LAUNCH_EXIT=$?
        fi
        ${
          isLinux
            ? `
        if [ $LAUNCH_EXIT -eq 124 ]; then
          echo "[neurodesk-app] ERROR: ${engineType} run timed out after 300s — Docker daemon may be stuck on NFS mount operations" >&2
          echo "[neurodesk-app] ERROR: If this persists, try: sudo systemctl restart docker" >&2
          exit 124
        fi`
            : ''
        }

        if [ $LAUNCH_EXIT -ne 0 ]; then
          echo "[neurodesk-app] ERROR: ${engineType} run exited with code $LAUNCH_EXIT" >&2
          echo "[neurodesk-app] ERROR: Checking container status:" >&2
          ${engineType} ps -a --filter name=${containerName} --format '{{.ID}} {{.Status}} {{.Names}}' 2>&1 >&2
          ${engineType} logs ${containerName} 2>&1 || true
          exit $LAUNCH_EXIT
        else
          echo "[neurodesk-app] Container started: $CONTAINER_ID"
          ${engineType} logs -f ${containerName} 2>&1
        fi
        `;
    }
  }

  return script;
}

/**
 * Detect the host OS version used to gate conditional run flags.
 * Returns '' when it cannot be determined (non-Linux, or no lsb_release).
 */
function getHostOsVersion(): string {
  if (os.platform() !== 'linux') {
    return '';
  }
  try {
    return execSync('lsb_release -a | grep Description')
      .toString()
      .split('Description:')[1]
      .trim()
      .split(' ')[1]
      .split('.')
      .join('')
      .slice(0, 4);
  } catch (error) {
    log.warn(`Could not determine host OS version: ${error}`);
    return '';
  }
}

function resolveTinyrangePath(isWin: boolean): string {
  const isDev = process.env.NODE_ENV === 'development';
  const binary = isWin ? 'tinyrange.exe' : 'tinyrange';
  return (isDev
    ? path.join(__dirname, '../../..', 'tinyrange', binary)
    : path.join(process.resourcesPath, 'app', 'tinyrange', binary)
  ).replace(/\\/g, '/');
}

/**
 * Resolve the host-side inputs (settings, paths, OS probing), hand them to
 * generateLaunchScript and write the result to a temp file.
 */
function createLaunchScript(
  serverInfo: JupyterServer.IInfo,
  engineType: EngineType,
  port: number,
  token: string,
  containerConfigName: string,
  imageVersion?: string
): { scriptPath: string; containerName: string } {
  const isWin = process.platform === 'win32';
  const isTinyRange = engineType === EngineType.TinyRange;

  const baseContainerConfigPath = path.join(
    __dirname,
    'config/baseContainerConfig.yml'
  );
  log.debug(
    `baseContainerConfigPath: ${baseContainerConfigPath}, containerConfigName: ${containerConfigName}`
  );

  const parser = new ContainerConfigParser(
    baseContainerConfigPath,
    requireContainerEntry(containerConfigName),
    imageVersion
  );

  if (!parser.isValid) {
    throw new Error(`Invalid container config: ${containerConfigName}`);
  }

  const customStorageDirectory = userSettings.getValue(
    SettingType.neurodesktopStorageDirectory
  );
  const storageDirectory =
    customStorageDirectory ||
    getDefaultStorageDirectory(
      process.platform,
      parser.getDefaultStorageMount()
    );
  if (!customStorageDirectory && !fs.existsSync(storageDirectory)) {
    fs.mkdirSync(storageDirectory, { recursive: true });
    if (process.platform === 'linux') {
      fs.chmodSync(storageDirectory, 0o777);
    }
  }

  if (isTinyRange) {
    const buildDir = path.join(storageDirectory, 'build');
    if (fs.existsSync(buildDir)) {
      fs.rmSync(path.join(buildDir, 'persist'), {
        recursive: true,
        force: true
      });
      log.info(`Removed TinyRange buildDir due to port change: ${buildDir}`);
    }
  }

  // The "additional working directory" setting is the only host directory
  // mounted into the container (at /data).
  let additionalDirectory = '';
  if (serverInfo.serverArgs) {
    additionalDirectory = resolveWorkingDirectory(serverInfo.serverArgs);
    if (process.platform === 'linux') {
      fs.chmodSync(additionalDirectory, 0o777);
    }
  }

  const additionalDirFsType = additionalDirectory
    ? getLinuxFileSystemType(additionalDirectory)
    : '';
  const isNfsAdditionalDirectory =
    process.platform === 'linux' &&
    ['nfs', 'nfs4'].includes(additionalDirFsType);

  const containerName = resolveContainerName(
    engineType,
    parser.getContainerName()
  );
  // Runs after resolveContainerName removed this user's own previous
  // container, which may still carry the legacy MAC.
  const sharedHost = detectSharedHost(engineType, containerName);
  log.info(
    `Shared-host detection: ${
      sharedHost
        ? "another user's container holds the legacy MAC, using per-user MAC address"
        : 'no other user running, using legacy MAC address'
    }`
  );

  log.info(
    `Server launch: port=${port} engine=${engineType} container=${containerName} image=${parser.getImageName()}`
  );
  log.info(
    `Additional directory diagnostics: raw="${serverInfo.serverArgs}" resolved="${additionalDirectory}" fsType="${additionalDirFsType}" isNfs=${isNfsAdditionalDirectory}`
  );

  const script = generateLaunchScript({
    parser,
    engineType,
    platform: process.platform,
    port,
    token,
    cvmfsMode: serverInfo.cvmfsMode.toString(),
    osVersion: getHostOsVersion(),
    tinyrangePath: resolveTinyrangePath(isWin),
    containerName,
    sharedHost,
    storageDirectory,
    additionalDirectory,
    isNfsAdditionalDirectory,
    overrideDefaultServerArgs: serverInfo.overrideDefaultServerArgs
  });

  const ext = isWin ? 'bat' : 'sh';
  const scriptPath = createTempFile(`launch.${ext}`, script);

  log.info(`Server launch script:\n${script}`);

  if (!isWin) {
    fs.chmodSync(scriptPath, 0o755);
  }

  return { scriptPath, containerName };
}

async function checkIfUrlExists(url: URL): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    let resolved = false;
    const done = (result: boolean) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(url, function (r) {
      // Consume response body to free the socket
      r.resume();
      done(r.statusCode! >= 200 && r.statusCode! < 400);
      log.debug(`Checking if ${url} exists... ${r.statusCode}`);
    });
    req.on('error', function (err) {
      done(false);
    });
    // Per-request timeout: if a single request hangs (e.g. TCP connected
    // but no HTTP response), abort it so polling can continue.
    // The outer waitForDeadline still controls the overall timeout.
    req.setTimeout(10000, () => {
      log.debug(`checkIfUrlExists: request to ${url} timed out`);
      req.destroy();
      done(false);
    });
    req.end();
  });
}

export async function waitUntilServerIsUp(url: URL): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    async function checkUrl() {
      const exists = await checkIfUrlExists(url);
      if (exists) {
        return resolve(true);
      } else {
        setTimeout(async () => {
          await checkUrl();
        }, 500);
      }
    }

    checkUrl();
  });
}

export class JupyterServer {
  constructor(options: JupyterServer.IOptions, progressView: ProgressView) {
    this._options = options;
    this._progressView = progressView;
    const workingDir =
      this._options.workingDirectory || userSettings.resolvedWorkingDirectory;
    this._info.workingDirectory = workingDir;
    this._info.containerConfigName = this._options.containerConfigName;
    this._info.imageVersion = this._options.imageVersion;

    const wsSettings = new WorkspaceSettings(workingDir);
    this._info.engine = wsSettings.getValue(SettingType.engineType);
    this._info.cvmfsMode = wsSettings.getValue(SettingType.cvmfsMode);
    this._info.serverArgs = wsSettings.getValue(SettingType.serverArgs);
    this._info.overrideDefaultServerArgs = wsSettings.getValue(
      SettingType.overrideDefaultServerArgs
    );
    this._info.serverEnvVars = wsSettings.getValue(SettingType.serverEnvVars);
  }

  get info(): JupyterServer.IInfo {
    return this._info;
  }

  /**
   * Start a local Jupyter server. This method can be
   * called multiple times without initiating multiple starts.
   *
   * @return a promise that is resolved when the server has started.
   */
  public start(port?: number, token?: string): Promise<JupyterServer.IInfo> {
    if (this._startServer) {
      return this._startServer;
    }
    let started = false;
    let stderrChunks: string[] = [];
    let stdoutChunks: string[] = [];

    log.info('Starting Jupyter server....');
    this._startServer = new Promise<JupyterServer.IInfo>(
      // eslint-disable-next-line no-async-promise-executor
      async (resolve, reject) => {
        const isWin = process.platform === 'win32';
        log.debug('isWin: ' + isWin);
        // const pythonPath = this._info.environment.path;
        // if (!fs.existsSync(pythonPath)) {
        //   reject(`Error: Environment not found at: ${pythonPath}`);
        //   return;
        // }
        // this._info.engine = getEngineType() || EngineType.Podman;
        this._info.port = port || this._options.port || (await getFreePort());
        this._info.token =
          token || this._options.token || this._generateToken();

        this._info.url = new URL(
          `http://127.0.0.1:${this._info.port}/lab?token=${this._info.token}`
        );

        log.debug('token', this._info.token);
        log.info(`ServerApp.port=${this._info.port}`);

        if (!this._info.containerConfigName) {
          reject('containerConfigName is required to launch a session');
          return;
        }

        let launchScriptPath: string;
        let containerName: string;
        try {
          ({ scriptPath: launchScriptPath, containerName } = createLaunchScript(
            this._info,
            this._info.engine,
            this._info.port,
            this._info.token,
            this._info.containerConfigName,
            this._info.imageVersion
          ));
        } catch (error) {
          reject(error);
          return;
        }
        this._info.containerName = containerName;

        const jlabWorkspacesDir = path.join(
          this._info.workingDirectory,
          '.jupyter',
          'desktop-workspaces'
        );

        const serverEnvVars = { ...this._info.serverEnvVars };

        // allow modifying PATH without replacing by using {PATH} variable
        if (process.env.PATH && 'PATH' in serverEnvVars) {
          serverEnvVars.PATH = serverEnvVars.PATH.replace(
            '{PATH}',
            process.env.PATH
          );
        }

        const execOptions = {
          cwd: os.tmpdir(),
          shell: isWin ? 'cmd.exe' : '/bin/bash',
          env: {
            ...process.env,
            JUPYTER_CONFIG_DIR:
              process.env.JLAB_DESKTOP_CONFIG_DIR || getUserDataDir(),
            JUPYTERLAB_WORKSPACES_DIR:
              process.env.JLAB_DESKTOP_WORKSPACES_DIR || jlabWorkspacesDir,
            ...serverEnvVars
          },
          timeout: 500000000,
          maxBuffer: 1024 * 1024 * 10 // increase max buffer to 10 MB
        };

        // console.debug(
        //   `Server launch parameters:\n  [script]: ${launchScriptPath}\n  [options]: ${JSON.stringify(
        //     execOptions
        //   )}`
        // );

        this._nbServer = execFile(launchScriptPath, execOptions);

        const deadline = { value: Date.now() + SERVER_LAUNCH_TIMEOUT };

        Promise.race([
          waitUntilServerIsUp(this._info.url),
          waitForDeadline(deadline)
        ])
          .then((up: boolean) => {
            if (up) {
              started = true;
              fs.unlinkSync(launchScriptPath);
              log.debug('delete launchScriptPath', launchScriptPath);
              resolve(this._info);
            } else {
              log.error("Server didn't start in time");
              this._serverStartFailed();
              reject(
                new Error(
                  'Failed to launch container from Promise ' +
                    this._info.port +
                    stderrChunks +
                    stdoutChunks
                )
              );
            }
          })
          .catch(err => {
            log.error('Server start race failed:', err);
            this._serverStartFailed();
            reject(err);
          });

        this._nbServer.stdout!.on('data', (data: string) => {
          // console.debug(`stdout: ${data}`);
          stdoutChunks = stdoutChunks.concat(data);
          if (this._progressView) {
            this._progressView.setChildProcessLog(data);
          }
          // When container starts, extend deadline for Jupyter startup
          if (data.includes('[neurodesk-app] Container started:')) {
            const newDeadline = Date.now() + JUPYTER_STARTUP_TIMEOUT;
            if (newDeadline > deadline.value) {
              log.info(
                `Container started — extending timeout by ${
                  JUPYTER_STARTUP_TIMEOUT / 60000
                } min for Jupyter startup`
              );
              deadline.value = newDeadline;
            }
          }
        });

        this._nbServer.stderr!.on('data', (data: string) => {
          // console.debug(`stderr: ${data}`);
          if (data.includes('The input device is not a TTY.')) {
            log.error('The input device is not a TTY.');
            // Handle the error appropriately here
          } else if (!data.includes('ERROR failed to dial vm port')) {
            log.warn(`stderr: ${data}`);
            stderrChunks = stderrChunks.concat(data);
            if (this._progressView) {
              this._progressView.setChildProcessLog(data);
            } else {
              log.debug('no progress view');
            }
            if (
              this._info.engine === EngineType.TinyRange &&
              !started &&
              (data.includes('operation not permitted') ||
                data.includes('FATAL') ||
                data.includes('panic:'))
            ) {
              log.error(`TinyRange fatal error detected: ${data}`);
              deadline.value = Date.now();
            }
          }
        });

        this._nbServer.on('error', (err: Error) => {
          if (started) {
            dialog.showMessageBox({
              message: `Container process errored: ${err.message}`,
              type: 'error'
            });
          } else {
            this._serverStartFailed();
            reject(err);
          }
        });

        this._nbServer.on('exit', (code, signal) => {
          const _code: number | null = code;
          stdoutChunks.concat(
            'child process exited with ' +
              `code ${code} and signal ${signal} on this._restartCount ${this._restartCount}`
          );
          log.info(
            'child process exited with ' + `code ${code} and signal ${signal}`
          );
          if (_code !== 0 && !started) {
            log.error(
              `Server process failed (code=${code}, signal=${signal}). ` +
                `engine=${this._info.engine} port=${this._info.port} container=${this._info.containerName} ` +
                `workingDir=${this._info.workingDirectory}\n` +
                `Last stderr: ${stderrChunks.slice(-5).join('')}\n` +
                `Last stdout: ${stdoutChunks.slice(-5).join('')}`
            );
          }
          if (
            _code === 0 &&
            !started &&
            this._info.engine !== EngineType.TinyRange
          ) {
            return;
          }
          if (_code === 0 || started) {
            /* On Windows, JupyterLab server sometimes crashes randomly during websocket
              connection. As a result of this, users experience kernel connections failures.
              This crash only happens when server is launched from electron app. Since we
              haven't been able to detect the exact cause of these crashes we are restarting the
              server at the same port. After the restart, users are able to launch new kernels
              for the notebook.
              */
            this._cleanupListeners();

            if (
              !this._stopping &&
              this._restartCount < SERVER_RESTART_LIMIT &&
              this._info.engine !== EngineType.TinyRange
            ) {
              started = false;
              this._startServer = null;
              this.start(this._info.port, this._info.token).catch(err => {
                log.error('Server restart failed:', err);
              });
              this._restartCount++;
            }
          } else {
            this._serverStartFailed();
            reject(new Error('Container process terminated' + stderrChunks));
          }
        });
      }
    );

    return this._startServer;
  }

  /**
   * Stop the currently executing Jupyter server.
   *
   * @return a promise that is resolved when the server has stopped.
   */
  public stop(): Promise<void> {
    // If stop has already been initiated, just return the promise
    if (this._stopServer) {
      return this._stopServer;
    }
    this._stopping = true;

    this._stopServer = new Promise<void>((resolve, reject) => {
      if (this._nbServer !== undefined) {
        const removeContainer = (shell: string) => {
          // Removing the container also stops Jupyter. An HTTP shutdown request
          // here races with rm -f and can fail with "socket hang up".
          execFile(
            `${this._info.engine} rm -f ${this._info.containerName}`,
            { shell, timeout: 10000 },
            (error, _stdout, stderr) => {
              if (
                error &&
                !/no such container|no container with name or ID/i.test(stderr)
              ) {
                reject(error);
              } else {
                resolve();
              }
            }
          );
        };
        if (process.platform === 'win32') {
          if (this._info.engine === EngineType.TinyRange) {
            execFile('taskkill', ['/IM', 'tinyrange.exe', '/T', '/F'], {
              shell: 'cmd.exe'
            });
            execFile(
              'taskkill',
              ['/IM', 'qemu-system-x86_64.exe', '/T', '/F'],
              {
                shell: 'cmd.exe'
              }
            );
          }
          execFile(
            'taskkill',
            ['/PID', String(this._nbServer.pid), '/T', '/F'],
            {
              shell: 'cmd.exe'
            }
          );
          if (this._info.engine === EngineType.TinyRange) {
            resolve();
          } else {
            removeContainer('cmd.exe');
          }
        } else {
          if (this._info.engine === EngineType.TinyRange) {
            // Kill tinyrange and any QEMU processes it spawned
            execFile(
              `killall tinyrange 2>/dev/null; killall tinyrange_qemu 2>/dev/null; killall qemu-system-x86_64 2>/dev/null; killall qemu-system-aarch64 2>/dev/null`,
              { shell: '/bin/bash' }
            );
          }
          this._nbServer.kill();
          if (this._info.engine === EngineType.TinyRange) {
            resolve();
          } else {
            removeContainer('/bin/bash');
          }
        }
      } else {
        resolve();
      }
    });
    return this._stopServer;
  }

  get started(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const checkStartServerPromise = () => {
        if (this._startServer) {
          this._startServer
            .then(() => {
              resolve(true);
            })
            .catch(reject);
        } else {
          setTimeout(() => {
            checkStartServerPromise();
          }, 100);
        }
      };

      checkStartServerPromise();
    });
  }

  private _serverStartFailed(): void {
    this._cleanupListeners();
    // Kill the child process (launch script running docker logs -f)
    if (this._nbServer && !this._nbServer.killed) {
      this._nbServer.kill();
    }
    // Remove the orphaned container asynchronously (don't block)
    if (this._info.containerName && this._info.engine) {
      const engine = this._info.engine;
      const container = this._info.containerName;
      const rmCmd =
        process.platform === 'win32'
          ? `${engine} rm -f ${container}`
          : `${
              process.platform === 'linux' ? 'timeout 30 ' : ''
            }${engine} rm -f ${container}`;
      execFile(rmCmd, {
        shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash'
      });
    }
    // Server didn't start, resolve stop promise
    this._stopServer = Promise.resolve();
  }

  private _cleanupListeners(): void {
    this._nbServer.removeAllListeners();
    this._nbServer.stderr?.removeAllListeners();
    this._nbServer.stdout?.removeAllListeners();
  }

  private _generateToken() {
    return SERVER_TOKEN_PREFIX + randomBytes(19).toString('hex');
  }

  /**
   * The child process object for the Jupyter server
   */
  private _nbServer: ChildProcess;
  private _stopServer: Promise<void> = null;
  private _startServer: Promise<JupyterServer.IInfo> = null;
  private _options: JupyterServer.IOptions;
  private _info: JupyterServer.IInfo = {
    type: 'local',
    engine: null,
    url: null,
    port: null,
    token: null,
    workingDirectory: null,
    containerConfigName: null,
    serverArgs: '',
    overrideDefaultServerArgs: false,
    serverEnvVars: {},
    version: null,
    cvmfsMode: null
  };
  private _stopping: boolean = false;
  private _restartCount: number = 0;
  private _progressView: ProgressView;
}

export namespace JupyterServer {
  export interface IOptions {
    port?: number;
    token?: string;
    workingDirectory?: string;
    containerConfigName?: string;
    imageVersion?: string;
  }

  export interface IInfo {
    type: 'local' | 'remote';
    engine: EngineType;
    url: URL;
    port: number;
    token: string;
    workingDirectory: string;
    containerConfigName?: string;
    imageVersion?: string;
    containerName?: string;
    serverArgs?: string;
    overrideDefaultServerArgs?: boolean;
    serverEnvVars?: KeyValueMap;
    version?: string;
    pageConfig?: any;
    cvmfsMode: string;
  }
}

export interface IServerFactory {
  /**
   * Create and start a 'free' server is none exists.
   *
   * @param opts the Jupyter server options.
   *
   * @return the factory item.
   */
  createFreeServersIfNeeded: (
    opts?: JupyterServer.IOptions,
    freeCount?: number
  ) => Promise<void>;

  /**
   * Create and start a 'free' server. The server created will be returned
   * in the next call to 'createServer'.
   *
   * This method is a way to pre-launch Jupyter servers to improve load
   * times.
   *
   * @param opts the Jupyter server options.
   *
   * @return the factory item.
   */
  createFreeServer: (
    opts?: JupyterServer.IOptions
  ) => Promise<JupyterServerFactory.IFactoryItem>;

  /**
   * Create a Jupyter server.
   *
   * If a free server is available, it is preferred over
   * server creation.
   *
   * @param opts the Jupyter server options.
   * @param forceNewServer force the creation of a new server over a free server.
   *
   * @return the factory item.
   */
  createServer: (
    opts?: JupyterServer.IOptions,
    progressView?: ProgressView
  ) => Promise<JupyterServerFactory.IFactoryItem>;

  /**
   * Kill all currently running servers.
   *
   * @return a promise that is fulfilled when all servers are killed.
   */
  killAllServers: () => Promise<void[]>;
}

export namespace IServerFactory {
  export interface IServerStarted {
    readonly factoryId: number;
    type: 'local' | 'remote';
    url: string;
    token: string;
    error?: Error;
    pageConfig?: any;
  }

  export interface IServerStop {
    factoryId: number;
  }
}

export class JupyterServerFactory implements IServerFactory, IDisposable {
  async createFreeServersIfNeeded(
    opts?: JupyterServer.IOptions,
    freeCount: number = 1
  ): Promise<void> {
    const unusedServerCount = await this._geUnusedServerCount();
    for (let i = unusedServerCount; i < freeCount; ++i) {
      this.createFreeServer(opts);
    }
  }

  /**
   * Create and start a 'free' server. The server created will be returned
   * in the next call to 'createServer'.
   *
   * This method is a way to pre-launch Jupyter servers to improve load
   * times.
   *
   * @param opts the Jupyter server options.
   *
   * @return the factory item.
   */
  async createFreeServer(
    opts?: JupyterServer.IOptions
  ): Promise<JupyterServerFactory.IFactoryItem> {
    let item: JupyterServerFactory.IFactoryItem;

    log.debug('~ createFreeServer', opts);
    item = this._createServer(opts);
    item.server.start().catch(error => {
      log.error('Failed to start server ~~', error);
      this._removeFailedServer(item.factoryId);
    });
    return item;
  }

  /**
   * Create a Jupyter server.
   *
   * If a free server is available, it is preferred over
   * server creation.
   *
   * @param opts the Jupyter server options.
   */
  async createServer(
    opts?: JupyterServer.IOptions,
    progressView?: ProgressView
  ): Promise<JupyterServerFactory.IFactoryItem> {
    let item: JupyterServerFactory.IFactoryItem;
    log.info('~ createServer', opts);

    item =
      (await this._findUnusedServer(opts)) ||
      this._createServer(opts, progressView);
    item.used = true;

    item.server.start().catch(error => {
      log.error('~ Failed to start server', error);
      this._removeFailedServer(item.factoryId);
    });

    log.debug('~ createServer ~ ', item);
    return item;
  }

  /**
   * Stop a Jupyter server.
   *
   * @param factoryId the factory item id.
   */
  stopServer(factoryId: number): Promise<void> {
    let idx = this._getServerIdx(factoryId);
    if (idx < 0) {
      return Promise.reject(new Error('Invalid server id: ' + factoryId));
    }

    let server = this._servers[idx];
    if (server.closing) {
      return server.closing;
    }
    let promise = new Promise<void>((res, rej) => {
      server.server
        .stop()
        .then(() => {
          ArrayExt.removeAt(this._servers, idx);
          res();
        })
        .catch(e => {
          log.error(e);
          ArrayExt.removeAt(this._servers, idx);
          rej();
        });
    });
    server.closing = promise;
    return promise;
  }

  /**
   * Kill all currently running servers.
   *
   * @return a promise that is fulfilled when all servers are killed.
   */
  killAllServers(): Promise<void[]> {
    // Get stop promises from all servers
    let stopPromises = this._servers.map(server => {
      return server.server.stop();
    });
    // Empty the server array.
    this._servers = [];
    return Promise.all(stopPromises);
  }

  dispose(): Promise<void> {
    if (this._disposePromise) {
      return this._disposePromise;
    }

    this._disposePromise = new Promise<void>((resolve, reject) => {
      this.killAllServers()
        .then(() => {
          resolve();
        })
        .catch(reject);
    });

    return this._disposePromise;
  }

  private _createServer(
    opts: JupyterServer.IOptions,
    progressView?: ProgressView
  ): JupyterServerFactory.IFactoryItem {
    let item: JupyterServerFactory.IFactoryItem = {
      factoryId: this._nextId++,
      server: new JupyterServer(opts, progressView),
      closing: null,
      used: false
    };

    this._servers.push(item);
    return item;
  }

  private async _findUnusedServer(
    opts?: JupyterServer.IOptions
  ): Promise<JupyterServerFactory.IFactoryItem | undefined> {
    const workingDir =
      opts?.workingDirectory || userSettings.resolvedWorkingDirectory;

    let result = ArrayExt.findFirstValue(
      this._servers,
      (server: JupyterServerFactory.IFactoryItem, idx: number) => {
        return (
          !server.used && server.server.info.workingDirectory === workingDir
        );
      }
    );

    return result;
  }

  private async _geUnusedServerCount(
    opts?: JupyterServer.IOptions
  ): Promise<number> {
    let count = 0;

    const workingDir =
      opts?.workingDirectory || userSettings.resolvedWorkingDirectory;

    this._servers.forEach(server => {
      if (!server.used && server.server.info.workingDirectory === workingDir) {
        count++;
      }
    });

    return count;
  }

  private _removeFailedServer(factoryId: number): void {
    let idx = this._getServerIdx(factoryId);
    if (idx < 0) {
      return;
    }
    ArrayExt.removeAt(this._servers, idx);
  }

  private _getServerIdx(factoryId: number): number {
    return ArrayExt.findFirstIndex(
      this._servers,
      (s: JupyterServerFactory.IFactoryItem, idx: number) => {
        if (s.factoryId === factoryId) {
          return true;
        }
        return false;
      }
    );
  }

  private _servers: JupyterServerFactory.IFactoryItem[] = [];
  private _nextId: number = 1;
  private _disposePromise: Promise<void>;
}

export namespace JupyterServerFactory {
  /**
   * The object created by the JupyterServerFactory.
   */
  export interface IFactoryItem {
    /**
     * The factory ID. Used to keep track of the server.
     */
    readonly factoryId: number;

    /**
     * Whether the server is currently used.
     */
    used: boolean;

    /**
     * A promise that is created when the server is closing
     * and resolved on close.
     */
    closing: Promise<void>;

    /**
     * The actual Jupyter server object.
     */
    server: JupyterServer;
  }
}
