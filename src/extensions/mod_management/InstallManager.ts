import { showDialog } from '../../actions/notifications';
import { ICheckbox, IDialogResult } from '../../types/IDialog';
import { IExtensionApi, ThunkStore } from '../../types/IExtensionContext';
import {IProfile, IState} from '../../types/IState';
import { DataInvalid, NotFound, ProcessCanceled, SetupError, TemporaryError,
         UserCanceled } from '../../util/CustomErrors';
import { createErrorReport, didIgnoreError,
        isOutdated, withContext } from '../../util/errorHandling';
import * as fs from '../../util/fs';
import getNormalizeFunc, { Normalize } from '../../util/getNormalizeFunc';
import lazyRequire from '../../util/lazyRequire';
import { log } from '../../util/log';
import { prettifyNodeErrorMessage } from '../../util/message';
import { activeProfile, downloadPathForGame } from '../../util/selectors';
import { getSafe, setSafe } from '../../util/storeHelper';
import { isPathValid, setdefault, truthy } from '../../util/util';
import walk from '../../util/walk';

import { IDownload } from '../download_management/types/IDownload';
import getDownloadGames from '../download_management/util/getDownloadGames';
import { IModType } from '../gamemode_management/types/IModType';
import { getGame } from '../gamemode_management/util/getGame';
import modName, { renderModReference } from '../mod_management/util/modName';
import { setModEnabled } from '../profile_management/actions/profiles';

import {addModRule, removeModRule, setFileOverride, setModAttribute,
        setModType} from './actions/mods';
import {Dependency, IDependency, IDependencyError, IModInfoEx} from './types/IDependency';
import { IInstallContext } from './types/IInstallContext';
import { IInstallResult, IInstruction, InstructionType } from './types/IInstallResult';
import { IFileListItem, IMod, IModReference, IModRule } from './types/IMod';
import { IModInstaller, ISupportedInstaller } from './types/IModInstaller';
import { InstallFunc } from './types/InstallFunc';
import { ISupportedResult, TestSupported } from './types/TestSupported';
import gatherDependencies, { isFuzzyVersion } from './util/dependencies';
import filterModInfo from './util/filterModInfo';
import queryGameId from './util/queryGameId';
import { referenceEqual } from './util/testModReference';

import InstallContext from './InstallContext';
import makeListInstaller from './listInstaller';
import deriveModInstallName from './modIdManager';

import * as Promise from 'bluebird';
import * as _ from 'lodash';
import { IHashResult, ILookupResult, IModInfo, IReference, IRule } from 'modmeta-db';
import Zip = require('node-7z');
import * as os from 'os';
import * as path from 'path';
import * as Redux from 'redux';
import * as semver from 'semver';

import * as modMetaT from 'modmeta-db';

const {genHash} = lazyRequire<typeof modMetaT>(() => require('modmeta-db'));

export class ArchiveBrokenError extends Error {
  constructor(message: string) {
    super(`Archive is broken: ${message}`);

    this.name = this.constructor.name;
  }
}

interface IReplaceChoice {
  id: string;
  variant: string;
  enable: boolean;
  attributes: { [key: string]: any };
}

interface IInvalidInstruction {
  type: InstructionType;
  error: string;
}

class InstructionGroups {
  public copy: IInstruction[] = [];
  public mkdir: IInstruction[] = [];
  public submodule: IInstruction[] = [];
  public generatefile: IInstruction[] = [];
  public iniedit: IInstruction[] = [];
  public unsupported: IInstruction[] = [];
  public attribute: IInstruction[] = [];
  public setmodtype: IInstruction[] = [];
  public error: IInstruction[] = [];
  public rule: IInstruction[] = [];
}

export const INI_TWEAKS_PATH = 'Ini Tweaks';

const archiveExtLookup = new Set<string>([
  '.zip', '.z01', '.7z', '.rar', '.r00', '.001', '.bz2', '.bzip2', '.gz', '.gzip',
  '.xz', '.z', '.lzh',
]);

/**
 * central class for the installation process
 *
 * @class InstallManager
 */
class InstallManager {
  private mInstallers: IModInstaller[] = [];
  private mGetInstallPath: (gameId: string) => string;
  private mTask: Zip;
  private mQueue: Promise<void>;

  constructor(installPath: (gameId: string) => string) {
    this.mGetInstallPath = installPath;
    this.mQueue = Promise.resolve();
  }

  /**
   * add an installer extension
   *
   * @param {number} priority priority of the installer. the lower the number the higher
   *                          the priority, so at priority 0 the extension would always be
   *                          the first to be queried
   * @param {TestSupported} testSupported
   * @param {IInstall} install
   *
   * @memberOf InstallManager
   */
  public addInstaller(
    priority: number,
    testSupported: TestSupported,
    install: InstallFunc) {
    this.mInstallers.push({ priority, testSupported, install });
    this.mInstallers.sort((lhs: IModInstaller, rhs: IModInstaller): number => {
      return lhs.priority - rhs.priority;
    });
  }

  /**
   * start installing a mod.
   *
   * @param {string} archiveId id of the download. may be null if the download isn't
   *                           in our download archive
   * @param {string} archivePath path to the archive file
   * @param {string} downloadGameId gameId of the download as reported by the downloader
   * @param {IExtensionApi} extension api
   * @param {*} info existing information about the mod (i.e. stuff retrieved
   *                 from the download page)
   * @param {boolean} processDependencies if true, test if the installed mod is dependent
   *                                      of others and tries to install those too
   * @param {boolean} enable if true, enable the mod after installation
   * @param {Function} callback callback once this is finished
   * @param {boolean} forceGameId set if the user has already been queried which game
   *                              to install the mod for
   * @param {IFileListItem[]} fileList if set, the listed files (and only those) get extracted
   *                                   directly, ignoring any installer scripts
   * @param {boolean} unattended if set and there is an option preset, the installation
   *                             will happen automatically without user interaction
   */
  public install(
    archiveId: string,
    archivePath: string,
    downloadGameIds: string[],
    api: IExtensionApi,
    info: any,
    processDependencies: boolean,
    enable: boolean,
    callback: (error: Error, id: string) => void,
    forceGameId?: string,
    fileList?: IFileListItem[],
    unattended?: boolean): void {

    if (this.mTask === undefined) {
      this.mTask = new Zip();
    }

    const fullInfo = { ...info };
    let rules: IRule[] = [];
    let overrides: string[] = [];
    let destinationPath: string;
    let tempPath: string;

    api.dismissNotification(`ready-to-install-${archiveId}`);

    const baseName = path.basename(archivePath, path.extname(archivePath));
    const currentProfile = activeProfile(api.store.getState());
    let modId = baseName;
    let installGameId: string;
    let installContext: InstallContext;
    let archiveMD5: string;
    let archiveSize: number;

    this.mQueue = this.mQueue
      .then(() => withContext('Installing', baseName, () => ((forceGameId !== undefined)
        ? Promise.resolve(forceGameId)
        : queryGameId(api.store, downloadGameIds, modId))
      .tap(() =>
        api.emitAndAwait('will-install-mod', currentProfile.gameId, archiveId, modId, fullInfo))
      // calculate the md5 hash here so we can store it with the mod meta information later,
      // otherwise we'd not remember the hash when installing from external file
      .tap(() => genHash(archivePath).then(hash => {
        archiveMD5 = hash.md5sum;
        archiveSize = hash.numBytes;
        setSafe(fullInfo, ['download', 'fileMD5'], archiveMD5);
        setSafe(fullInfo, ['download', 'size'], archiveSize);
      }).catch(() => null))
      .then(gameId => {
        installGameId = gameId;
        if (installGameId === undefined) {
          return Promise.reject(
            new ProcessCanceled('You need to select a game before installing this mod'));
        }
        installContext = new InstallContext(gameId, api);
        installContext.startIndicator(baseName);
        let dlGame: string | string[] = getSafe(fullInfo, ['download', 'game'], gameId);
        if (Array.isArray(dlGame)) {
          dlGame = dlGame[0];
        }
        return api.lookupModMeta({
          filePath: archivePath,
          fileMD5: archiveMD5,
          fileSize: archiveSize,
          gameId: dlGame as string,
        });
      })
      .then((modInfo: ILookupResult[]) => {
        log('debug', 'got mod meta information', { archivePath, resultCount: modInfo.length });
        if (modInfo.length > 0) {
          fullInfo.meta = modInfo[0].value;
        }

        modId = this.deriveInstallName(baseName, fullInfo);
        let testModId = modId;
        // if the name is already taken, consult the user,
        // repeat until user canceled, decided to replace the existing
        // mod or provided a new, unused name
        const checkNameLoop = () => this.checkModExists(testModId, api, installGameId)
          ? this.queryUserReplace(modId, installGameId, api)
            .then((choice: IReplaceChoice) => {
              testModId = choice.id;
              if (choice.enable) {
                enable = true;
              }
              setdefault(fullInfo, 'custom', {} as any).variant = choice.variant;
              fullInfo.previous = choice.attributes;
              return checkNameLoop();
            })
          : Promise.resolve(testModId);
        return checkNameLoop();
      })
      // TODO: this is only necessary to get at the fileId and the fileId isn't
      //   even a particularly good way to discover conflicts
      .then(newModId => {
        modId = newModId;
        log('debug', 'mod id for newly installed mod', { archivePath, modId });
        return filterModInfo(fullInfo, undefined);
      })
      .then(modInfo => {
        const oldMod = (modInfo.fileId !== undefined)
          ? this.findPreviousVersionMod(modInfo.fileId, api.store, installGameId)
          : undefined;

        if ((oldMod !== undefined) && (fullInfo.choices === undefined)) {
          fullInfo.choices = getSafe(oldMod, ['attributes', 'installerChoices'], undefined);
        }

        if ((oldMod !== undefined) && (currentProfile !== undefined)) {
          const wasEnabled = getSafe(currentProfile.modState, [oldMod.id, 'enabled'], false);
          return this.userVersionChoice(oldMod, api.store)
            .then((action: string) => {
              if (action === 'Install') {
                enable = enable || wasEnabled;
                if (wasEnabled) {
                  setModEnabled(currentProfile.id, oldMod.id, false);
                  api.events.emit('mods-enabled', [oldMod.id], false, currentProfile.gameId);
                }
                return Promise.resolve();
              } else if (action === 'Replace') {
                rules = oldMod.rules || [];
                overrides = oldMod.fileOverrides;
                // we need to remove the old mod before continuing. This ensures
                // the mod is deactivated and undeployed (so we're not leave dangling
                // links) and it ensures we do a clean install of the mod
                return new Promise<void>((resolve, reject) => {
                  api.events.emit('remove-mod', currentProfile.gameId, oldMod.id,
                                  (error: Error) => {
                    if (error !== null) {
                      reject(error);
                    } else {
                      // use the same mod id as the old version so that all profiles
                      // keep using it.
                      modId = oldMod.id;
                      enable = enable || wasEnabled;
                      resolve();
                    }
                  });
                });
              }
            });
        } else {
          return Promise.resolve();
        }
      })
      .then(() => {
        installContext.startInstallCB(modId, installGameId, archiveId);

        destinationPath = path.join(this.mGetInstallPath(installGameId), modId);
        log('debug', 'installing to', { modId, destinationPath });
        installContext.setInstallPathCB(modId, destinationPath);
        tempPath = destinationPath + '.installing';
        return this.installInner(api, archivePath,
                                 tempPath, destinationPath, installGameId, installContext,
                                 fullInfo.choices, fileList, unattended);
      })
      .then(result => {
        const state: IState = api.store.getState();

        if (getSafe(state, ['persistent', 'mods', installGameId, modId, 'type'], '') === '') {
          return this.determineModType(installGameId, result.instructions)
              .then(type => {
                installContext.setModType(modId, type);
                return result;
              });
        } else {
          return Promise.resolve(result);
        }
      })
      .then(result => this.processInstructions(api, archivePath, tempPath, destinationPath,
                                               installGameId, modId, result))
      .finally(() => (tempPath !== undefined)
        ? fs.removeAsync(tempPath) : Promise.resolve())
      .then(() => filterModInfo(fullInfo, destinationPath))
      .then(modInfo => {
        installContext.finishInstallCB('success', modInfo);
        rules.forEach(rule => {
          api.store.dispatch(addModRule(installGameId, modId, rule));
        });
        api.store.dispatch(setFileOverride(installGameId, modId, overrides));
        if (currentProfile !== undefined) {
          if (enable) {
            api.store.dispatch(setModEnabled(currentProfile.id, modId, true));
            api.events.emit('mods-enabled', [modId], true, currentProfile.gameId);
          }
          /*
          if (processDependencies) {
            log('info', 'process dependencies', { modId });
            const state: IState = api.store.getState();
            const mod: IMod = getSafe(state, ['persistent', 'mods', installGameId, modId],
                                      undefined);

            this.installDependenciesImpl(api, currentProfile,
                                         mod.id, modName(mod),
                                         [].concat(modInfo.rules || [], mod.rules || []),
                                         this.mGetInstallPath(installGameId))
              .then(() => this.installRecommendationsImpl(
                                         api, currentProfile,
                                         mod.id, modName(mod),
                                         [].concat(modInfo.rules || [], mod.rules || []),
                                         this.mGetInstallPath(installGameId)));
          }
          */
        }
        if (callback !== undefined) {
          callback(null, modId);
        }
        api.events.emit('did-install-mod', currentProfile.gameId, archiveId, modId, modInfo);
        return null;
      })
      .catch(err => {
        // TODO: make this nicer. especially: The first check doesn't recognize UserCanceled
        //   exceptions from extensions, hence we have to do the string check (last one)
        const canceled = (err instanceof UserCanceled)
                         || (err instanceof TemporaryError)
                         || (err instanceof ProcessCanceled)
                         || (err === null)
                         || (err.message === 'Canceled')
                         || ((err.stack !== undefined)
                             && err.stack.startsWith('UserCanceled: canceled by user'));
        let prom = destinationPath !== undefined
          ? fs.removeAsync(destinationPath)
            .catch(UserCanceled, () => null)
            .catch(innerErr => {
              installContext.reportError(
                'Failed to clean up installation directory "{{destinationPath}}", '
                + 'please close Vortex and remove it manually.',
                innerErr, innerErr.code !== 'ENOTEMPTY', { destinationPath });
            })
          : Promise.resolve();

        if (installContext !== undefined) {
          const pretty = prettifyNodeErrorMessage(err);
          // context doesn't have to be set if we canceled early
          prom = prom.then(() => installContext.finishInstallCB(
            canceled ? 'canceled' : 'failed',
            undefined,
            api.translate(pretty.message, { replace: pretty.replace })));
        }

        if (err === undefined) {
          return prom.then(() => {
            if (callback !== undefined) {
              callback(new Error('unknown error'), null);
            }
          });
        } else if (canceled) {
          return prom.then(() => {
            if (callback !== undefined) {
              callback(err, null);
            }
          });
        } else if (err instanceof ArchiveBrokenError) {
          return prom
            .then(() => {
              if (installContext !== undefined) {
                installContext.reportError(
                  'Installation failed',
                  `The archive {{ installerPath }} is damaged and couldn't be installed. `
                  + 'This is most likely fixed by re-downloading the file.', false,
                  { installerPath: path.basename(archivePath) });
              }
            });
        } else if (err instanceof SetupError) {
          return prom
            .then(() => {
              if (installContext !== undefined) {
                installContext.reportError(
                  'Installation failed',
                  err,
                  false, {
                    installerPath: path.basename(archivePath),
                    message: err.message,
                  });
              }
            });
        } else if (err instanceof DataInvalid) {
          return prom
            .then(() => {
              if (installContext !== undefined) {
                installContext.reportError(
                  'Installation failed',
                  'The installer {{ installerPath }} is invalid and couldn\'t be '
                  + 'installed:\n{{ message }}\nPlease inform the mod author.\n',
                  false, {
                    installerPath: path.basename(archivePath),
                    message: err.message,
                  });
              }
            });
        } else {
          return prom
            .then(() => genHash(archivePath).catch(() => ({})))
            .then((hashResult: IHashResult) => {
              const id = `${path.basename(archivePath)} (md5: ${hashResult.md5sum})`;
              let message = err;
              let replace = {};
              if (typeof err === 'string') {
                message = 'The installer "{{ id }}" failed: {{ message }}';
                replace = {
                      id,
                      message: err,
                    };
              }
              if (installContext !== undefined) {
                const browserAssistantMsg = 'The installer has failed due to an external 3rd '
                  + 'party application you have installed on your system named '
                  + '"Browser Assistant". This application inserts itself globally '
                  + 'and breaks any other application that uses the same libraries as it does.\n\n'
                  + 'To use Vortex, please uninstall "Browser Assistant".';
                const errorMessage = (typeof err === 'string') ? err : err.message;
                (!this.isBrowserAssistantError(errorMessage))
                  ? installContext.reportError('Installation failed', message, undefined, replace)
                  : installContext.reportError('Installation failed', browserAssistantMsg, false);
              }
              if (callback !== undefined) {
                callback(err, modId);
              }
            });
        }
      })
      .finally(() => {
        if (installContext !== undefined) {
          const state = api.store.getState();
          const mod: IMod = getSafe(state, ['persistent', 'mods', installGameId, modId], undefined);
          installContext.stopIndicator(mod);
        }
      })));
  }

  public installDependencies(api: IExtensionApi, profile: IProfile, modId: string,
                             silent: boolean): Promise<void> {
    const state: IState = api.store.getState();
    const mod: IMod = getSafe(state, ['persistent', 'mods', profile.gameId, modId], undefined);

    if (mod === undefined) {
      return Promise.reject(new ProcessCanceled(`Invalid mod specified "${mod}"`));
    }

    this.repairRules(api, mod, profile.gameId);

    const installPath = this.mGetInstallPath(profile.gameId);
    return this.installDependenciesImpl(api, profile, mod.id, modName(mod), mod.rules,
                                        installPath, silent);
  }

  public installRecommendations(api: IExtensionApi,
                                profile: IProfile,
                                modId: string)
                                : Promise<void> {
    const state: IState = api.store.getState();
    const mod: IMod = getSafe(state, ['persistent', 'mods', profile.gameId, modId], undefined);

    if (mod === undefined) {
      return Promise.reject(new ProcessCanceled(`Invalid mod specified "${mod}"`));
    }

    this.repairRules(api, mod, profile.gameId);

    const installPath = this.mGetInstallPath(profile.gameId);
    return this.installRecommendationsImpl(api, profile, mod.id, modName(mod),
                                           mod.rules, installPath);
  }

  private hasFuzzyReference(ref: IModReference): boolean {
    return (ref.fileExpression !== undefined)
        || (ref.fileMD5 !== undefined)
        || (ref.logicalFileName !== undefined);
  }

  /**
   * when installing a mod from a dependency rule we store the id of the installed mod
   * in the rule for quicker and consistent matching but if - at a later time - we
   * install those same dependencies again we have to unset those ids, otherwise the
   * dependence installs would fail.
   */
  private repairRules(api: IExtensionApi, mod: IMod, gameId: string) {
    const state: IState = api.store.getState();
    const mods = state.persistent.mods[gameId];

    (mod.rules || []).forEach(rule => {
      if ((rule.reference.id !== undefined)
          && (mods[rule.reference.id] === undefined)
          && this.hasFuzzyReference(rule.reference)) {
        const newRule: IModRule = JSON.parse(JSON.stringify(rule));
        api.store.dispatch(removeModRule(gameId, mod.id, rule));
        delete newRule.reference.id;
        api.store.dispatch(addModRule(gameId, mod.id, newRule));
      }
    });
  }

  private isBrowserAssistantError(error: string): boolean {
    return (process.platform === 'win32')
        && (error.indexOf('Roaming\\Browser Assistant') !== -1);
  }

  private isCritical(error: string): boolean {
    return (error.indexOf('Unexpected end of archive') !== -1)
        || (error.indexOf('ERROR: Data Error') !== -1)
        || (error.indexOf('Can not open the file as archive') !== -1);
  }

  /**
   * find the right installer for the specified archive, then install
   */
  private installInner(api: IExtensionApi, archivePath: string,
                       tempPath: string, destinationPath: string,
                       gameId: string, installContext: IInstallContext,
                       installChoices?: any,
                       extractList?: IFileListItem[],
                       unattended?: boolean): Promise<IInstallResult> {
    const fileList: string[] = [];
    const progress = (files: string[], percent: number) => {
      if ((percent !== undefined) && (installContext !== undefined)) {
        installContext.setProgress(percent);
      }
    };
    // process.noAsar = true;
    log('debug', 'extracting mod archive', { archivePath, tempPath });
    return this.mTask.extractFull(archivePath, tempPath, {ssc: false},
                                  progress,
                                  () => this.queryPassword(api.store))
        .catch((err: Error) => this.isCritical(err.message)
          ? Promise.reject(new ArchiveBrokenError(err.message))
          : Promise.reject(err))
        .then(({ code, errors }: {code: number, errors: string[] }) => {
          log('debug', 'extraction completed', { code, errors });
          if (installContext !== undefined) {
            installContext.setProgress();
          }
          if (code !== 0) {
            log('warn', 'extraction reported error', { code, errors });
            const critical = errors.find(this.isCritical);
            if (critical !== undefined) {
              return Promise.reject(new ArchiveBrokenError(critical));
            }
            return this.queryContinue(api, errors);
          } else {
            return Promise.resolve();
          }
        })
        .catch(ArchiveBrokenError, err => {
          if (archiveExtLookup.has(path.extname(archivePath).toLowerCase())) {
            return Promise.reject(err);
          }

          // this is really a completely separate process from the "regular" mod installation
          return api.showDialog('question', 'Not an archive', {
            text: 'Vortex is designed to install mods from archives but this doesn\'t look '
              + 'like one. Do you want to create a mod containing just this file?',
            message: archivePath,
          }, [
              { label: 'Cancel' },
              { label: 'Create Mod' },
            ]).then(result => {
              if (result.action === 'Cancel') {
                return Promise.reject(new UserCanceled());
              }

              return fs.ensureDirAsync(tempPath)
                .then(() => fs.copyAsync(archivePath,
                  path.join(tempPath, path.basename(archivePath))));
            });
        })
        .then(() => walk(tempPath,
                         (iterPath, stats) => {
                           if (stats.isFile()) {
                             fileList.push(path.relative(tempPath, iterPath));
                           } else {
                             // unfortunately we also have to pass directories because
                             // some mods contain empty directories to control stop-folder
                             // management...
                             fileList.push(path.relative(tempPath, iterPath) + path.sep);
                           }
                           return Promise.resolve();
                         }))
        .finally(() => {
          // process.noAsar = false;
        })
        .then(() => (extractList !== undefined)
          ? makeListInstaller(extractList, tempPath)
          : this.getInstaller(fileList, gameId))
        .then(supportedInstaller => {
          if (supportedInstaller === undefined) {
            throw new Error('no installer supporting this file');
          }

          const {installer, requiredFiles} = supportedInstaller;
          // TODO: We don't have an id for installers - that would be useful here...
          log('debug', 'invoking installer', supportedInstaller.installer.priority);
          return installer.install(
              fileList, tempPath, gameId,
              (perc: number) => log('info', 'progress', perc),
              installChoices,
              unattended);
        });
  }

  private determineModType(gameId: string, installInstructions: IInstruction[]): Promise<string> {
    log('info', 'determine mod type', { gameId });
    const game = getGame(gameId);
    if (game === undefined) {
      return Promise.reject(new Error(`Invalid game "${gameId}"`));
    }
    const modTypes: IModType[] = game.modTypes;
    // sort with priority descending so we can stop as soon as we've hit the first match
    const sorted = modTypes.sort((lhs, rhs) => rhs.priority - lhs.priority);
    let found = false;

    return Promise.mapSeries(sorted, (type: IModType): Promise<string> => {
      if (found) {
        return Promise.resolve<string>(null);
      }

      return type.test(installInstructions)
      .then(matches => {
        if (matches) {
          found = true;
          return Promise.resolve(type.typeId);
        } else {
          return Promise.resolve(null);
        }
      });
    }).then(matches => matches.find(match => match !== null) || '');
  }

  private queryContinue(api: IExtensionApi,
                        errors: string[]): Promise<void> {
    const terminal = errors.find(err => err.indexOf('Can not open the file as archive') !== -1);

    return new Promise<void>((resolve, reject) => {
      api.store.dispatch(showDialog('error', api.translate('Archive damaged'), {
        bbcode: api.translate('Encountered errors extracting this archive. Please verify this '
                  + 'file was downloaded correctly.\n[list]{{ errors }}[/list]', {
                  replace: { errors: errors.map(err => '[*] ' + err) } }),
        options: { translated: true },
      }, [
          { label: 'Cancel', action: () => reject(new UserCanceled()) },
      ].concat(terminal ? [] : [
          { label: 'Continue', action: () => resolve() },
        ])));
    });
  }

  private queryPassword(store: ThunkStore<any>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      store
          .dispatch(showDialog(
              'info', 'Password Protected',
              {
                input: [{
                  id: 'password',
                  type: 'password',
                  value: '',
                  label: 'A password is required to extract this archive',
                }],
              }, [ { label: 'Cancel' }, { label: 'Continue' } ]))
          .then((result: IDialogResult) => {
            if (result.action === 'Continue') {
              resolve(result.input['password']);
            } else {
              reject(new UserCanceled());
            }
          });
    });
  }

  private validateInstructions(instructions: IInstruction[]): IInvalidInstruction[] {
    const sanitizeSep = new RegExp('/', 'g');
    // Validate the ungrouped instructions and return errors (if any)
    const invalidDestinationErrors: IInvalidInstruction[] = instructions.filter(instr => {
      if (!!instr.destination) {
        // This is a temporary hack to avoid invalidating fomod instructions
        //  which will include a path separator at the beginning of a relative path
        //  when matching nested stop patterns.
        const destination = (instr.destination.charAt(0) === path.sep)
          ? instr.destination.substr(1)
          : instr.destination;

        // Ensure we use windows path separators as scripted installers
        //  will sometime return *nix separators.
        const sanitized = (process.platform === 'win32')
          ? destination.replace(sanitizeSep, path.sep)
          : destination;
        return (!isPathValid(sanitized, true));
      }

      return false;
    }).map(instr => {
        return {
          type: instr.type,
          error: `invalid destination path: "${instr.destination}"`,
        };
      });

    return [].concat(invalidDestinationErrors);
  }

  private transformInstructions(input: IInstruction[]): InstructionGroups {
    return input.reduce((prev, value) => {
      if (truthy(value) && (prev[value.type] !== undefined)) {
        prev[value.type].push(value);
      }
      return prev;
    }, new InstructionGroups());
  }

  private reportUnsupported(api: IExtensionApi, unsupported: IInstruction[], archivePath: string) {
    if (unsupported.length === 0) {
      return;
    }
    const missing = unsupported.map(instruction => instruction.source);
    const makeReport = () =>
        genHash(archivePath)
            .catch(err => ({}))
            .then(
                (hashResult: IHashResult) => createErrorReport(
                    'Installer failed',
                    {
                      message: 'The installer uses unimplemented functions',
                      details:
                          `Missing instructions: ${missing.join(', ')}\n` +
                              `Installer name: ${path.basename(archivePath)}\n` +
                              `MD5 checksum: ${hashResult.md5sum}\n`,
                    }, {},
                    ['installer'], api.store.getState()));
    const showUnsupportedDialog = () => api.store.dispatch(showDialog(
        'info', 'Installer unsupported',
        {
          message:
              'This installer is (partially) unsupported as it\'s ' +
              'using functionality that hasn\'t been implemented yet. ' +
              'Please help us fix this by submitting an error report with a link to this mod.',
        }, (isOutdated() || didIgnoreError()) ? [
          { label: 'Close' },
        ] : [
          { label: 'Report', action: makeReport },
          { label: 'Close' },
        ]));

    api.sendNotification({
      type: 'info',
      message: 'Installer unsupported',
      actions: [{title: 'More', action: showUnsupportedDialog}],
    });
  }

  private processMKDir(instructions: IInstruction[],
                       destinationPath: string): Promise<void> {
    return Promise.each(instructions,
                        instruction => fs.ensureDirAsync(path.join(
                            destinationPath, instruction.destination)))
        .then(() => undefined);
  }

  private processGenerateFiles(generatefile: IInstruction[],
                               destinationPath: string): Promise<void> {
    return Promise.each(generatefile, gen => {
      const outputPath = path.join(destinationPath, gen.destination);
      return fs.ensureDirAsync(path.dirname(outputPath))
        .then(() => fs.writeFileAsync(outputPath, gen.data));
    }).then(() => undefined);
  }

  private processSubmodule(api: IExtensionApi, submodule: IInstruction[],
                           destinationPath: string,
                           gameId: string, modId: string): Promise<void> {
    return Promise.each(submodule,
      mod => {
        const tempPath = destinationPath + '.' + mod.key + '.installing';
        return this.installInner(api, mod.path, tempPath, destinationPath,
                                 gameId, undefined)
          .then((resultInner) => this.processInstructions(
            api, mod.path, tempPath, destinationPath,
            gameId, mod.key, resultInner))
          .then(() => {
            if (mod.submoduleType !== undefined) {
              api.store.dispatch(setModType(gameId, modId, mod.submoduleType));
            }
          })
          .finally(() => fs.removeAsync(tempPath));
      })
        .then(() => undefined);
  }

  private processAttribute(api: IExtensionApi, attribute: IInstruction[],
                           gameId: string, modId: string): Promise<void> {
    attribute.forEach(attr => {
      api.store.dispatch(setModAttribute(gameId, modId, attr.key, attr.value));
    });
    return Promise.resolve();
  }

  private processSetModType(api: IExtensionApi, types: IInstruction[],
                            gameId: string, modId: string): Promise<void> {
    if (types.length > 0) {
      api.store.dispatch(setModType(gameId, modId, types[types.length - 1].value));
      if (types.length > 1) {
        log('error', 'got more than one mod type, only the last was used', { types });
      }
    }
    return Promise.resolve();
  }

  private processRule(api: IExtensionApi, rules: IInstruction[],
                      gameId: string, modId: string): Promise<void> {
    rules.forEach(rule => {
      api.store.dispatch(addModRule(gameId, modId, rule.rule));
    });
    return Promise.resolve();
  }

  private processIniEdits(iniEdits: IInstruction[], destinationPath: string): Promise<void> {
    if (iniEdits.length === 0) {
      return Promise.resolve();
    }

    const byDest: { [dest: string]: IInstruction[] } = iniEdits.reduce((prev, value) => {
      setdefault(prev, value.destination, []).push(value);
      return prev;
    }, {});

    return fs.ensureDirAsync(path.join(destinationPath, INI_TWEAKS_PATH))
      .then(() => Promise.map(Object.keys(byDest), destination => {
      const bySection: {[section: string]: IInstruction[]} =
          byDest[destination].reduce((prev, value) => {
            setdefault(prev, value.section, []).push(value);
            return prev;
          }, {});

      const renderKV = (instruction: IInstruction): string =>
          `${instruction.key} = ${instruction.value}`;

      const renderSection = (section: string) => [
        `[${section}]`,
      ].concat(bySection[section].map(renderKV)).join(os.EOL);

      const content = Object.keys(bySection).map(renderSection).join(os.EOL);

      return fs.writeFileAsync(path.join(destinationPath, INI_TWEAKS_PATH, destination), content);
    }))
    .then(() => undefined);
  }

  private processInstructions(api: IExtensionApi, archivePath: string,
                              tempPath: string, destinationPath: string,
                              gameId: string, modId: string,
                              result: { instructions: IInstruction[] }) {
    if (result.instructions === null) {
      // this is the signal that the installer has already reported what went
      // wrong. Not necessarily a "user canceled" but the error handling happened
      // in the installer so we don't know what happened.
      return Promise.reject(new UserCanceled());
    }

    if ((result.instructions === undefined) ||
        (result.instructions.length === 0)) {
      return Promise.reject(new ProcessCanceled('Empty archive or no options selected'));
    }

    const invalidInstructions = this.validateInstructions(result.instructions);
    if (invalidInstructions.length > 0) {
      const game = getGame(gameId);
      const allowReport = (game.contributed === undefined);
      const error = (allowReport)
        ? 'Invalid installer instructions found for "{{ modId }}".'
        : 'Invalid installer instructions found for "{{ modId }}". Please inform '
          + 'the game extension\'s developer - "{{ contributor }}", or the mod author.';
      api.showErrorNotification('Invalid mod installer instructions', {
        invalid: '\n' + invalidInstructions.map(inval =>
          `(${inval.type}) - ${inval.error}`).join('\n'),
        message: error,
      }, {
        replace: {
          modId,
          contributor: game.contributed,
        },
        allowReport,
      });
      return Promise.reject(new ProcessCanceled('Invalid installer instructions'));
    }

    const instructionGroups = this.transformInstructions(result.instructions);

    if (instructionGroups.error.length > 0) {
      const fatal = instructionGroups.error.find(err => err.value === 'fatal');
      let error = 'Errors were reported processing the installer for "{{ modId }}". ';

      if (fatal === undefined) {
        error += 'It\'s possible the mod works (partially) anyway. '
        + 'Please note that NMM tends to ignore errors so just because NMM doesn\'t '
        + 'report a problem with this installer doesn\'t mean it doesn\'t have any.';
      }

      api.showErrorNotification('Installer reported errors',
        error + '\n{{ errors }}', {
          replace: {
            errors: instructionGroups.error.map(err => err.source).join('\n'),
            modId,
          },
          allowReport: false,
          message: modId,
        });
      if (fatal !== undefined) {
        return Promise.reject(new ProcessCanceled('Installer script failed'));
      }
    }

    log('debug', 'installer instructions',
        JSON.stringify(result.instructions.map(instr => _.omit(instr, ['data']))));
    this.reportUnsupported(api, instructionGroups.unsupported, archivePath);

    return this.processMKDir(instructionGroups.mkdir, destinationPath)
      .then(() => this.extractArchive(api, archivePath, tempPath, destinationPath,
                                      instructionGroups.copy))
      .then(() => this.processGenerateFiles(instructionGroups.generatefile,
                                            destinationPath))
      .then(() => this.processIniEdits(instructionGroups.iniedit, destinationPath))
      .then(() => this.processSubmodule(api, instructionGroups.submodule,
                                        destinationPath, gameId, modId))
      .then(() => this.processAttribute(api, instructionGroups.attribute, gameId, modId))
      .then(() => this.processSetModType(api, instructionGroups.setmodtype, gameId, modId))
      .then(() => this.processRule(api, instructionGroups.rule, gameId, modId))
      ;
    }

  private checkModExists(installName: string, api: IExtensionApi, gameMode: string): boolean {
    return installName in (api.store.getState().persistent.mods[gameMode] || {});
  }

  private findPreviousVersionMod(fileId: number, store: Redux.Store<any>,
                                 gameMode: string): IMod {
    const mods = store.getState().persistent.mods[gameMode] || {};
    let mod: IMod;
    Object.keys(mods).forEach(key => {
      const newestFileId: number = getSafe(mods[key].attributes, ['newestFileId'], undefined);
      const currentFileId: number = getSafe(mods[key].attributes, ['fileId'], undefined);
      if (newestFileId !== currentFileId && newestFileId === fileId) {
        mod = mods[key];
      }
    });

    return mod;
  }

  private userVersionChoice(oldMod: IMod, store: ThunkStore<any>): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      store.dispatch(showDialog(
          'question', modName(oldMod),
          {
            text:
            'An older version of this mod is already installed.' +
            'You can replace the existing one or install this one alongside it. ' +
            'If you have other profiles they will continue using the old version.',
            options: { wrap: true },
          },
          [
            { label: 'Cancel' },
            { label: 'Replace' },
            { label: 'Install' },
          ]))
        .then((result: IDialogResult) => {
          if (result.action === 'Cancel') {
            reject(new UserCanceled());
          } else {
            resolve(result.action);
          }
        });
    });
  }

  private queryUserReplace(modId: string, gameId: string, api: IExtensionApi) {
    return new Promise<IReplaceChoice>((resolve, reject) => {
      const state: IState = api.store.getState();
      const mod: IMod = state.persistent.mods[gameId][modId];
      api.store
        .dispatch(showDialog(
          'question', modName(mod, { version: false }),
          {
            text:
              'This mod seems to be installed already. You can replace the ' +
              'existing one or install the new one under a different name. ' +
              'If you do the latter, the new installation will appear as a variant ' +
              'of the other mod that can be toggled through the version dropdown. ' +
              'Use the input below to make the variant distinguishable.',
            input: [{
              id: 'variant',
              value: '2',
              label: 'Variant',
            }],
            options: {
              wrap: true,
            },
          },
          [
            { label: 'Cancel' },
            { label: 'Add Variant' },
            { label: 'Replace' },
          ]))
        .then((result: IDialogResult) => {
          if (result.action === 'Cancel') {
            reject(new UserCanceled());
          } else if (result.action === 'Add Variant') {
            resolve({
              id: modId + '+' + result.input.variant,
              variant: result.input.variant,
              enable: false,
              attributes: {},
            });
          } else if (result.action === 'Replace') {
            const currentProfile = activeProfile(api.store.getState());
            const wasEnabled = (currentProfile !== undefined) && (currentProfile.gameId === gameId)
              ? getSafe(currentProfile.modState, [modId, 'enabled'], false)
              : false;
            api.events.emit('remove-mod', gameId, modId, (err) => {
              if (err !== null) {
                reject(err);
              } else {
                resolve({
                  id: modId,
                  variant: '',
                  enable: wasEnabled,
                  attributes: _.omit(mod.attributes, ['version', 'fileName', 'fileVersion']),
                });
              }
            });
          }
        });
    });
  }

  private getInstaller(
    fileList: string[],
    gameId: string,
    offsetIn?: number): Promise<ISupportedInstaller> {
    const offset = offsetIn || 0;
    if (offset >= this.mInstallers.length) {
      return Promise.resolve(undefined);
    }
    return this.mInstallers[offset].testSupported(fileList, gameId)
      .then((testResult: ISupportedResult) => (testResult.supported === true)
          ? Promise.resolve({
              installer: this.mInstallers[offset],
              requiredFiles: testResult.requiredFiles,
            })
          : this.getInstaller(fileList, gameId, offset + 1));
 }

  /**
   * determine the mod name (on disk) from the archive path
   * TODO: this currently simply uses the archive name which should be fine
   *   for downloads from nexus but in general we need the path to encode the
   *   mod, the specific "component" and the version. And then we need to avoid
   *   collisions.
   *   Finally, the way I know users they will want to customize this.
   *
   * @param {string} archiveName
   * @param {*} info
   * @returns
   */
  private deriveInstallName(archiveName: string, info: any) {
    return deriveModInstallName(archiveName, info);
  }

  private downloadURL(api: IExtensionApi, lookupResult: IModInfoEx): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (!api.events.emit('start-download', [lookupResult.sourceURI], {
        game: lookupResult.gameId,
        source: lookupResult.source,
        name: lookupResult.logicalFileName,
        referer: lookupResult.referer,
        ids: {
          modId: getSafe(lookupResult, ['details', 'modId'], undefined),
          fileId: getSafe(lookupResult, ['details', 'fileId'], undefined),
        },
      }, undefined,
        (error, id) => {
          if (error === null) {
            resolve(id);
          } else {
            reject(error);
          }
        })) {
        reject(new Error('download manager not installed?'));
      }
    });
  }

  private downloadMatching(api: IExtensionApi, lookupResult: IModInfoEx,
                           pattern: string): Promise<string> {
    const modId: string = getSafe(lookupResult, ['details', 'modId'], undefined);
    const fileId: string = getSafe(lookupResult, ['details', 'fileId'], undefined);
    if ((modId === undefined) && (fileId === undefined)) {
      return this.downloadURL(api, lookupResult);
    }
    return api.emitAndAwait('start-download-update',
      lookupResult.source, lookupResult.domainName || lookupResult.gameId, modId, fileId, pattern)
      .then(dlIds => (dlIds === undefined)
          ? Promise.reject(new NotFound(`source not supported "${lookupResult.source}"`))
          : !truthy(dlIds[0])
          ? Promise.reject(new ProcessCanceled('Download failed', { alreadyReported: true }))
          : Promise.resolve(dlIds[0]));
  }

  private downloadModAsync(
    requirement: IReference,
    lookupResult: IModInfoEx,
    api: IExtensionApi): Promise<string> {
    if ((requirement.versionMatch !== undefined)
      && (isNaN(parseInt(requirement.versionMatch[0], 16))
        || (semver.validRange(requirement.versionMatch)
          !== requirement.versionMatch))) {
      // seems to be a fuzzy matcher so we may have to look for an update
      return this.downloadMatching(api, lookupResult, requirement.versionMatch)
        .then(res => (res === undefined)
          ? this.downloadURL(api, lookupResult)
          : res);
    } else {
      return this.downloadURL(api, lookupResult);
    }
  }

  private applyExtraFromRule(api: IExtensionApi, profile: IProfile, modId: string, extra?: { [key: string]: any }) {
    if (extra === undefined) {
      return;
    }

    if (extra.type !== undefined) {
      api.store.dispatch(setModType(profile.gameId, modId, extra.type));
    }

    if (extra.name !== undefined) {
      api.store.dispatch(setModAttribute(profile.gameId, modId, 'customFileName', extra.name));
    }
  }

  private doInstallDependencies(api: IExtensionApi,
                                profile: IProfile,
                                sourceModId: string,
                                dependencies: IDependency[],
                                recommended: boolean): Promise<IDependency[]> {
    const state: IState = api.store.getState();
    const downloads = state.persistent.downloads.files;

    return Promise.map(dependencies, (dep: IDependency) => {
      let dlPromise = Promise.resolve(dep.download);
      log('debug', 'installing as dependency', {
        ref: JSON.stringify(dep.reference),
        downloadRequired: dep.download === undefined,
      });
      if (dep.download === undefined) {
        if (getSafe(dep, ['lookupResults', 0, 'value', 'sourceURI'], '') === '') {
          dlPromise = Promise.reject(new ProcessCanceled('Failed to determine download url'));
        } else {
          dlPromise = this.downloadModAsync(
            dep.reference,
            dep.lookupResults[0].value,
            api);
        }
      } else if (dep.download === null) {
        dlPromise = Promise.reject(new ProcessCanceled('Failed to determine download url'));
      } else if (downloads[dep.download].state === 'paused') {
        dlPromise = new Promise((resolve, reject) => {
          api.events.emit('resume-download', dep.download, (err) => err !== null ? reject(err) : resolve(dep.download));
        });
      }
      return dlPromise
        .then((downloadId: string) => (dep.mod === undefined)
           ? this.installModAsync(dep.reference, api, downloadId,
                                  { choices: dep.installerChoices }, dep.fileList)
           : Promise.resolve(dep.mod.id))
        .then((modId: string) => {
          api.store.dispatch(setModEnabled(profile.id, modId, true));
          this.applyExtraFromRule(api, profile, modId, dep.extra);

          const state: IState = api.store.getState();
          const mods = state.persistent.mods[profile.gameId];
          return { ...dep, mod: mods[modId] };
        })
        // don't cancel the whole process if one dependency fails to install
        .catch(ProcessCanceled, err => {
          if ((err.extraInfo !== undefined) && err.extraInfo.alreadyReported) {
            return;
          }
          api.showErrorNotification('Failed to install dependency',
            '{{errorMessage}}\nA common cause for issues here is that the file may no longer '
            + 'be available. You may want to install a current version of the specified mod '
            + 'and update or remove the dependency for the old one.', {
            allowReport: false,
            message: renderModReference(dep.reference, undefined),
            replace: {
              errorMessage: err.message,
            },
          });
        })
        .catch(NotFound, err => {
          api.showErrorNotification('Failed to install dependency', err, {
            allowReport: false,
          });
        })
        .catch(err => {
          if (err instanceof UserCanceled) {
            return Promise.reject(err);
          }
          api.showErrorNotification('Failed to install dependency', err, {
            message: renderModReference(dep.reference, undefined),
          });
        })
        .then((updatedDependency: IDependency) => {
          log('debug', 'done installing dependency', {
            ref: JSON.stringify(dep.reference),
          });
          return updatedDependency;
        });
    // install/download up to 4 mods at once to allow Vortex to download one mod while another is
    // being installed. Obviously Vortex isn't going to do the install for multiple mods at once
    // and the downloads are going to be limited by the number of download threads but still the
    // queue is going to stay utilized
    }, { concurrency: 4 })
      .catch(ProcessCanceled, err => {
        // This indicates an error in the dependency rules so it's
        // adequate to show an error but not as a bug in Vortex
        api.showErrorNotification('Failed to install dependencies',
          err.message, { allowReport: false });
        return [];
      })
      .catch(UserCanceled, () => [])
      .catch(err => {
        api.showErrorNotification('Failed to install dependencies',
          err.message);
        return [];
      })
      .filter(dep => dep !== undefined);
  }

  private updateRules(api: IExtensionApi, profile: IProfile, sourceModId: string,
                      dependencies: IDependency[], recommended: boolean): Promise<void> {
    dependencies.map(dep => {
      const updatedRef: IModReference = { ...dep.reference };
      updatedRef.id = dep.mod.id;
      if (isFuzzyVersion(dep.reference.versionMatch)
        && (dep.reference.fileMD5 !== undefined)
        && ((dep.reference.logicalFileName !== undefined)
          || (dep.reference.fileExpression !== undefined))) {
        updatedRef.fileMD5 = undefined;
      }

      const state: IState = api.store.getState();
      const rules: IModRule[] =
        getSafe(state.persistent.mods, [profile.gameId, sourceModId, 'rules'], []);
      const oldRule = rules.find(iter => referenceEqual(iter.reference, dep.reference));
      api.store.dispatch(removeModRule(profile.gameId, sourceModId, oldRule));
      api.store.dispatch(addModRule(profile.gameId, sourceModId, {
        ...(oldRule || {}),
        type: recommended ? 'recommends' : 'requires',
        reference: updatedRef,
      }));
    });
    return Promise.resolve();
  }

  private installDependenciesImpl(api: IExtensionApi,
                                  profile: IProfile,
                                  modId: string,
                                  name: string,
                                  rules: IModRule[],
                                  installPath: string,
                                  silent: boolean)
                                  : Promise<void> {
    const notificationId = `${installPath}_activity`;
    api.events.emit('will-install-dependencies', profile.id, modId, false);
    api.sendNotification({
      id: notificationId,
      type: 'activity',
      message: 'Checking dependencies',
    });
    log('debug', 'installing dependencies', { modId, name });
    return gatherDependencies(rules, api, false)
      .then((dependencies: Dependency[]) => {
        api.dismissNotification(notificationId);

        if (dependencies.length === 0) {
          return Promise.resolve();
        }

        interface IDependencySplit {
          success: IDependency[];
          existing: IDependency[];
          error: IDependencyError[];
        }
        const { success, existing, error } = dependencies.reduce(
          (prev: IDependencySplit, dep: Dependency) => {
            if (dep['error'] !== undefined) {
              prev.error.push(dep as IDependencyError);
            } else {
              const { mod } = dep as IDependency;
              if ((mod === undefined) || (!getSafe(profile.modState, [mod.id, 'enabled'], false))) {
                prev.success.push(dep as IDependency);
              } else {
                prev.existing.push(dep as IDependency);
              }
            }
            return prev;
          }, { success: [], existing: [], error: [] });

        log('debug', 'determined unfulfilled dependencies',
            { count: success.length, errors: error.length });

        if (silent && (error.length === 0)) {
          return this.doInstallDependencies(api, profile, modId, success, false)
            .then(updated => this.updateRules(api, profile, modId,
              [].concat(existing, updated), false));
        }

        const state: IState = api.store.getState();
        const downloads = state.persistent.downloads.files;

        const requiredInstalls = success.filter(dep => dep.mod === undefined);
        const requiredDownloads = requiredInstalls.filter(dep => {
          return (dep.download === undefined)
              || (downloads[dep.download].state === 'paused');
        });

        let bbcode = '';

        if (success.length > 0) {
          bbcode += '{{modName}} has {{count}} unresolved dependencies. '
                  + '{{instCount}} mods have to be installed, '
                  + '{{dlCount}} of them have to be downloaded first.<br/><br/>';
        }

        if (error.length > 0) {
          bbcode += '[color=red]'
            + '{{modName}} has unsolved dependencies that could not be found automatically. '
            + 'Please install them manually:<br/>'
            + '{{errors}}'
            + '[/color]';
        }

        if (success.length === 0) {
          return Promise.resolve();
        }

        const actions = [
            { label: 'Cancel' },
            { label: 'Enable' },
          ];

        return api.store.dispatch(
          showDialog('question', 'Install Dependencies', { bbcode, parameters: {
            modName: name,
            count: success.length,
            instCount: requiredInstalls.length,
            dlCount: requiredDownloads.length,
            errors: error.map(err => err.error).join('<br/>'),
          } }, actions)).then(result => {
            if (result.action === 'Enable') {
              return this.doInstallDependencies(api, profile, modId, success, false)
                .then(updated => this.updateRules(api, profile, modId,
                                                  [].concat(existing, updated), false));
            } else {
              return Promise.resolve();
            }
          });
      })
      .catch((err) => {
        api.dismissNotification(notificationId);
        api.showErrorNotification('Failed to check dependencies', err);
      })
      .finally(() => {
        log('debug', 'done installing dependencies', { profile: profile.id, modId });
        api.events.emit('did-install-dependencies', profile.id, modId, false);
      });
  }

  private installRecommendationsImpl(api: IExtensionApi,
                                     profile: IProfile,
                                     modId: string,
                                     name: string,
                                     rules: IRule[],
                                     installPath: string)
                                     : Promise<void> {
    const notificationId = `${installPath}_activity`;
    api.events.emit('will-install-dependencies', profile.id, modId, true);
    api.sendNotification({
      id: notificationId,
      type: 'activity',
      message: 'Checking dependencies',
    });
    return gatherDependencies(rules, api, true)
      .then((dependencies: Dependency[]) => {
        api.dismissNotification(notificationId);

        if (dependencies.length === 0) {
          return Promise.resolve();
        }

        interface IDependencySplit {
          success: IDependency[];
          existing: IDependency[];
          error: IDependencyError[];
        }
        const { success, existing, error } = dependencies.reduce(
          (prev: IDependencySplit, dep: Dependency) => {
            if (dep['error'] !== undefined) {
              prev.error.push(dep as IDependencyError);
            } else {
              const { mod } = dep as IDependency;
              if ((mod === undefined) || (!getSafe(profile.modState, [mod.id, 'enabled'], false))) {
                prev.success.push(dep as IDependency);
              } else {
                prev.existing.push(dep as IDependency);
              }
            }
            return prev;
          }, { success: [], existing: [], error: [] });

        const state: IState = api.store.getState();
        const downloads = state.persistent.downloads.files;

        const requiredDownloads =
          success.reduce((prev: number, current: IDependency) => {
            const isDownloaded = current.download !== undefined
                              && downloads[current.download].state !== 'paused';
            return prev + (isDownloaded ? 0 : 1);
          }, 0);

        let bbcode = '';

        if (success.length > 0) {
          bbcode += '{{modName}} recommends the installation of additional mods. '
                   + 'Please use the checkboxes below to select which to install.<br/><br/>';
        }

        if (error.length > 0) {
          bbcode += '[color=red]'
            + '{{modName}} has unsolved dependencies that could not be found automatically. '
            + 'Please install them manually.'
            + '[/color]';
        }

        const checkboxes: ICheckbox[] = success.map((dep, idx) => {
          let depName: string;
          if (dep.lookupResults.length > 0) {
            depName = dep.lookupResults[0].value.fileName;
          }
          if (depName === undefined) {
            depName = renderModReference(dep.reference, undefined);
          }

          let desc = depName;
          if (dep.download === undefined) {
            desc += ' (' + api.translate('Not downloaded yet') + ')';
          }
          return {
            id: idx.toString(),
            text: desc,
            value: true,
          };
        });

        const actions = success.length > 0
          ? [
            { label: 'Don\'t install' },
            { label: 'Install' },
          ]
          : [ { label: 'Close' } ];

        return api.store.dispatch(
          showDialog('question', 'Install Recommendations', {
            bbcode,
            checkboxes,
            parameters: {
              modName: name,
              count: dependencies.length,
              dlCount: requiredDownloads,
            },
          }, actions)).then(result => {
            if (result.action === 'Install') {
              const selected = new Set(Object.keys(result.input)
                .filter(key => result.input[key]));

              return this.doInstallDependencies(
                api,
                profile,
                modId,
                success.filter((dep, idx) => selected.has(idx.toString())),
                true)
                .then(updated => this.updateRules(api, profile, modId,
                  [].concat(existing, updated), true));
            } else {
              return Promise.resolve();
            }
          });
      })
      .catch((err) => {
        api.dismissNotification(notificationId);
        api.showErrorNotification('Failed to check dependencies', err);
      })
      .finally(() => {
        api.events.emit('did-install-dependencies', profile.id, modId, true);
      });
  }

  private installModAsync(requirement: IReference,
                          api: IExtensionApi,
                          downloadId: string,
                          modInfo?: any,
                          fileList?: IFileListItem[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const state = api.store.getState();
      const download: IDownload = state.persistent.downloads.files[downloadId];
      if (download === undefined) {
        return reject(new Error(`Invalid download id (${downloadId})`));
      }
      const downloadGame: string = Array.isArray(download.game) ? download.game[0] : download.game;
      const fullPath: string =
        path.join(downloadPathForGame(state, downloadGame), download.localPath);
      this.install(downloadId, fullPath, getDownloadGames(download),
        api, { ...modInfo, download }, false, false, (error, id) => {
          if (error === null) {
            resolve(id);
          } else {
            reject(error);
          }
        }, undefined, fileList, true);
    });
  }

  private fixDestination(source: string, destination: string): Promise<string> {
    // if the source is an existing file an the destination is an existing directory,
    // copyAsync or renameAsync will not work, they expect the destination to be the
    // name of the output file.
    return fs.statAsync(source)
      .then(sourceStat => sourceStat.isDirectory()
        ? Promise.resolve(destination)
        : fs.statAsync(destination)
          .then(destStat => destStat.isDirectory()
            ? path.join(destination, path.basename(source))
            : destination))
      .catch(() => Promise.resolve(destination));
  }

  private transferFile(source: string, destination: string, move: boolean): Promise<void> {
    return fs.ensureDirAsync(path.dirname(destination))
      .then(() => this.fixDestination(source, destination))
      .then(fixedDest => move
        ? fs.renameAsync(source, fixedDest)
        : fs.copyAsync(source, fixedDest, { noSelfCopy: true }));
  }

  /**
   * extract an archive
   *
   * @export
   * @param {string} archivePath path to the archive file
   * @param {string} destinationPath path to install to
   */
  private extractArchive(
    api: IExtensionApi,
    archivePath: string,
    tempPath: string,
    destinationPath: string,
    copies: IInstruction[]): Promise<void> {
    let normalize: Normalize;

    const missingFiles: string[] = [];
    return fs.ensureDirAsync(destinationPath)
        .then(() => getNormalizeFunc(destinationPath))
        .then((normalizeFunc: Normalize) => {
          normalize = normalizeFunc;
        })
        .then(() => {
          const sourceMap: {[src: string]: string[]} =
              copies.reduce((prev, copy) => {
                setdefault(prev, copy.source, []).push(copy.destination);
                return prev;
              }, {});
          // for each source, copy or rename to destination(s)
          return Promise.mapSeries(Object.keys(sourceMap), srcRel => {
            const sourcePath = path.join(tempPath, srcRel);
            // need to do this sequentially, otherwise we can't use the idx to
            // decide between rename and copy
            return Promise.mapSeries(sourceMap[srcRel], (destRel, idx, len) => {
              const destPath = path.join(destinationPath, destRel);
              return this.transferFile(sourcePath, destPath, idx === len - 1)
                .catch(err => {
                  if (err.code === 'ENOENT') {
                    missingFiles.push(srcRel);
                  } else if (err.code === 'EPERM') {
                    return this.transferFile(sourcePath, destPath, false);
                  } else {
                    return Promise.reject(err);
                  }
                });
            });
          });
        })
        .then(() => {
          if (missingFiles.length > 0) {
            api.showErrorNotification(api.translate('Invalid installer'),
              api.translate('The installer in "{{name}}" tried to install files that were '
                            + 'not part of the archive.\nThis is a bug in the mod, please '
                            + 'report it to the mod author.\n'
                            + 'Please note: NMM silently ignores this kind of errors so you '
                            + 'might get this message for mods that appear to install '
                            + 'fine with NMM. The mod will likely work, at least partially.',
                          { replace: {name: path.basename(archivePath)} })
              + '\n\n' + missingFiles.map(name => '- ' + name).join('\n')
            , { allowReport: false });
          }
        });
  }
}

export default InstallManager;
