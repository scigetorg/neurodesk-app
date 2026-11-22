import { app, Menu, MenuItem } from 'electron';
import log, { LevelOption } from 'electron-log';
import yargs from 'yargs/yargs';
import * as fs from 'fs';
import * as path from 'path';
import { getAppDir, isDevMode, waitForFunction } from './utils';
import { execSync } from 'child_process';
import { JupyterApplication } from './app';
import { ICLIArguments } from './tokens';
import { SessionConfig } from './config/sessionconfig';
import { SettingType, userSettings } from './config/settings';

const release = require(path.join(__dirname, '..', 'package.json')).version;

function setDisplayNamePreservingUserData(displayName: string): void {
  const userDataPath = app.getPath('userData');
  app.setName(displayName);
  app.setPath('userData', userDataPath);
}

setDisplayNamePreservingUserData('Sciget App');

/** Move settings from a stale config directory (e.g. an interim rename) into
 *  the current userData path so users don't lose their settings. */
function migrateStaleConfigDir(): void {
  const currentDir = app.getPath('userData');
  const staleNames = ['scigetapp', 'Sciget', 'Sciget App', 'ScigetApp'];
  const homeDir = app.getPath('home');
  let candidates: string[] = [];

  if (process.platform === 'linux') {
    const configBase =
      process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    candidates = staleNames.map(n => path.join(configBase, n));
  } else if (process.platform === 'darwin') {
    candidates = staleNames.map(n =>
      path.join(homeDir, 'Library', 'Application Support', n)
    );
  } else if (process.platform === 'win32') {
    const appData =
      process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    candidates = staleNames.map(n => path.join(appData, n));
  }

  for (const staleDir of candidates) {
    if (
      staleDir !== currentDir &&
      fs.existsSync(staleDir) &&
      fs.existsSync(path.join(staleDir, 'settings.json'))
    ) {
      try {
        // Only migrate if the current dir has no settings yet
        if (!fs.existsSync(path.join(currentDir, 'settings.json'))) {
          if (!fs.existsSync(currentDir)) {
            fs.mkdirSync(currentDir, { recursive: true });
          }
          for (const file of fs.readdirSync(staleDir)) {
            const src = path.join(staleDir, file);
            const dest = path.join(currentDir, file);
            if (!fs.existsSync(dest)) {
              const stat = fs.statSync(src);
              if (stat.isDirectory()) {
                fs.mkdirSync(dest, { recursive: true });
                for (const child of fs.readdirSync(src)) {
                  fs.copyFileSync(
                    path.join(src, child),
                    path.join(dest, child)
                  );
                }
              } else {
                fs.copyFileSync(src, dest);
              }
            }
          }
        }
        // Remove the stale directory after migration
        fs.rmSync(staleDir, { recursive: true, force: true });
      } catch {
        // Best-effort: don't block startup
      }
    }
  }
}

migrateStaleConfigDir();

let jupyterApp: JupyterApplication;
let fileToOpenInMainInstance = '';

async function appReady(): Promise<boolean> {
  // wait for electron app ready
  await app.whenReady();
  // wait for jupyterApp created
  await waitForFunction((): boolean => {
    return !!jupyterApp;
  });

  return true;
}

/**
 *  * On Mac OSX the PATH env variable a packaged app gets does not
 * contain all the information that is usually set in .bashrc, .bash_profile, etc.
 * This package fixes the PATH variable
 */
require('fix-path')();

function parseArgs(argv: string[]) {
  return yargs(argv)
    .usage('scigetapp [options] folder/file paths')
    .example('scigetapp', 'Launch in default working directory')
    .example('scigetapp .', 'Launch in current directory')
    .example(
      'scigetapp /data/nb/test.ipynb',
      'Launch in /data/nb and open test.ipynb'
    )
    .example('scigetapp /data/nb', 'Launch in /data/nb')
    .example(
      'scigetapp --working-dir /data/nb test.ipynb sub/test2.ipynb',
      'Launch in /data/nb and open /data/nb/test.ipynb and /data/nb/sub/test2.ipynb'
    )
    .option('working-dir', {
      describe: 'Working directory',
      type: 'string'
    })
    .option('log-level', {
      describe: 'Log level',
      choices: ['error', 'warn', 'info', 'verbose', 'debug'],
      default: 'info'
    })
    .help('h')
    .alias({
      h: 'help'
    })
    .parseSync();
}

function getLogLevel(): LevelOption {
  if (isDevMode()) {
    return 'debug';
  }

  const cliLogLevelSet = process.argv?.indexOf('--log-level') > -1;
  if (cliLogLevelSet) {
    return argv.logLevel as LevelOption;
  }

  return userSettings.getValue(SettingType.logLevel);
}

const argv = parseArgs(process.argv.slice(isDevMode() ? 2 : 1));
const logLevel = getLogLevel();

if (isDevMode()) {
  log.transports.console.level = logLevel;
  log.transports.file.level = logLevel;

  log.info('In development mode');
  log.info(`Logging to console at '${log.transports.console.level}' level`);
} else {
  log.transports.file.level = logLevel;
  log.transports.console.level = false;

  log.info('In production mode');
  log.info(
    `Logging to file (${log.transports.file.getFile().path}) at '${
      log.transports.file.level
    }' level`
  );
}

console.log = log.log;
console.error = log.error;
console.warn = log.warn;
console.info = log.info;
console.debug = log.debug;

const thisYear = new Date().getFullYear();

app.setAboutPanelOptions({
  applicationName: 'Sciget App',
  applicationVersion: release,
  version: release,
  website: 'https://github.com/scigetorg/neurodesk-app',
  copyright: `© MIT License ${thisYear}`
});

// when a file is double clicked or dropped on the app icon on OS,
// this method is called
app.on('open-file', (event: Electron.Event, filePath: string) => {
  event.preventDefault();

  // open-file will be called early at launch, so there is chance to pass to main instance
  fileToOpenInMainInstance = filePath;

  appReady().then(() => {
    let fileOrFolders: string[] = [];

    try {
      if (process.platform === 'win32') {
        fileOrFolders = process.argv.slice(1); // TODO: this looks incorrect
      } else {
        fileOrFolders = [filePath];
      }
    } catch (error) {
      console.error('Failed to open files', error);
    }

    if (fileOrFolders.length > 0) {
      jupyterApp.handleOpenFilesOrFolders(fileOrFolders);
    }
  });
});

function setupJLabCommand() {
  if (process.platform !== 'darwin') {
    return;
  }

  const symlinkPath = '/usr/local/bin/scigetapp';
  const legacyPath = '/usr/local/bin/neurodeskapp';
  const targetPath = `${getAppDir()}/app/scigetapp`;

  if (!fs.existsSync(targetPath)) {
    return;
  }

  try {
    if (!fs.existsSync(symlinkPath)) {
      const cmd = `ln -s ${targetPath} ${symlinkPath}`;
      execSync(cmd, { shell: '/bin/bash' });
      fs.chmodSync(symlinkPath, 0o755);
    }

    // Backward-compatible alias so "neurodeskapp" still works
    if (!fs.existsSync(legacyPath)) {
      execSync(`ln -s ${symlinkPath} ${legacyPath}`, { shell: '/bin/bash' });
    }

    // after a DMG install, mode resets
    fs.chmodSync(targetPath, 0o755);
  } catch (error) {
    log.error(error);
  }
}

function setApplicationMenu() {
  if (process.platform !== 'darwin') {
    return;
  }

  // hide Help menu
  const menu = Menu.getApplicationMenu();
  let viewMenu: MenuItem | undefined;
  menu?.items.forEach(item => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (item.role === 'help') {
      item.visible = false;
    }

    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (item.role === 'viewmenu') {
      viewMenu = item;
    }
  });
  // hide Reload and Force Reload menu items
  viewMenu?.submenu?.items.forEach(item => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    if (item.role === 'reload' || item.role === 'forcereload') {
      item.visible = true;
      item.enabled = true;
    }
  });
  Menu.setApplicationMenu(menu);
}

// Ensure SIGTERM/SIGHUP trigger Electron's will-quit flow so that
// dispose() -> killAllServers() -> docker rm runs before the process exits.
// Without this, sending kill -TERM to the app leaves the container running.
for (const sig of ['SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    console.log(`Received ${sig}, quitting app…`);
    app.quit();
  });
}

/**
 * Load all services when the electron app is
 * ready.
 */
app.on('ready', () => {
  handleMultipleAppInstances()
    .then(() => {
      setApplicationMenu();
      setupJLabCommand();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      argv.cwd = process.cwd();
      jupyterApp = new JupyterApplication((argv as unknown) as ICLIArguments);
    })
    .catch(e => {
      log.error(e);
      app.quit();
    });
});

/**
 * When a second instance of the application is executed, this passes the arguments
 * to first instance. Files that are opened with the application on Linux and Windows
 * will by default instantiate a new instance of the app with the file name as the args.
 * This instead opens the files in the first instance of the
 * application.
 */
function handleMultipleAppInstances(): Promise<void> {
  let promise = new Promise<void>((resolve, reject) => {
    // only the first instance will get the lock
    // pass cliArgs to main instance since argv provided by second-instance
    // event is out of order
    const gotLock = app.requestSingleInstanceLock({
      cliArgs: argv,
      fileToOpenInMainInstance
    });
    if (gotLock) {
      app.on('second-instance', (event, argv, cwd, additionalData: any) => {
        // second instance created by double clicking a file
        if (additionalData?.fileToOpenInMainInstance) {
          jupyterApp.handleOpenFilesOrFolders([
            additionalData.fileToOpenInMainInstance
          ]);
        } else if (additionalData?.cliArgs) {
          // second instance created using CLI
          const cliArgs = additionalData.cliArgs;
          cliArgs.cwd = cwd;
          const sessionConfig = SessionConfig.createFromArgs(
            (cliArgs as unknown) as ICLIArguments
          );

          // On Linux, check if we have files to open from command line arguments
          // This handles the case when a file is double-clicked
          if (sessionConfig) {
            jupyterApp.openSession(sessionConfig);
          } else if (cliArgs._ && cliArgs._.length > 0) {
            // Handle file paths passed directly (e.g., from file manager)
            const filePaths = cliArgs._.map((f: string) =>
              path.isAbsolute(f) ? f : path.resolve(cwd, f)
            );
            jupyterApp.handleOpenFilesOrFolders(filePaths);
          } else {
            console.warn(`[SECOND-INSTANCE] No files found in cliArgs`);
          }
        }
      });
      resolve();
    } else {
      // is second instance
      app.quit();
      reject();
    }
  });
  return promise;
}
