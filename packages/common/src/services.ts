import { PageConfig, URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { JSONObject, PromiseDelegate } from '@lumino/coreutils';
import { ISignal, Signal } from '@lumino/signaling';
import { Conda, IEnvironmentManager } from './tokens';

/**
 * Type of environment that can be created.
 */
interface IType {
  [key: string]: string[];
}

namespace RESTAPI {
  /**
   * Description of the REST API response when loading environments
   */
  export interface IEnvironments {
    /**
     * List of available environments.
     */
    environments: Array<Conda.IEnvironment>;
  }

  /**
   * Package properties returned by conda tools
   */
  export interface IRawPackage {
    /**
     * Package name
     */
    name: string;
    /**
     * Package version
     */
    version: string;
    /**
     * Build number
     */
    build_number: number;
    /**
     * Build string
     */
    build_string: string;
    /**
     * Channel
     */
    channel: string;
    /**
     * Platform
     */
    platform: string;
  }
}

/**
 * Cancellable actions
 */
export interface ICancellableAction {
  /**
   * Type of cancellable action
   */
  type: string;
  /**
   * Cancellable function
   */
  cancel: () => void;
}

/**
 * Conda Environment Manager
 */
export class CondaEnvironments implements IEnvironmentManager {
  constructor(settings?: ISettingRegistry.ISettings) {
    this._environments = new Array<Conda.IEnvironment>();

    if (settings) {
      this._updateSettings(settings);
      settings.changed.connect(this._updateSettings, this);

      const clean = new Promise<void>(
        ((resolve: () => void): void => {
          this._clean = resolve;
        }).bind(this)
      );

      clean.then(() => {
        settings.changed.disconnect(this._updateSettings, this);
      });
    }
  }

  get environments(): Promise<Array<Conda.IEnvironment>> {
    return this.refresh().then(() => {
      return Promise.resolve(this._environments);
    });
  }

  get environmentChanged(): ISignal<
    IEnvironmentManager,
    Conda.IEnvironmentChange
  > {
    return this._environmentChanged;
  }

  getPackageManager(name?: string): Conda.IPackageManager {
    this._packageManager.environment = name;
    return this._packageManager;
  }

  /**
   * Test whether the manager is disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Get the list of packages to install for a given environment type.
   *
   * The returned package list is the input type split with " ".
   *
   * @param type Environment type
   * @returns List of packages to create the environment
   */
  getEnvironmentFromType(type: string): string[] {
    if (type in this._environmentTypes) {
      return this._environmentTypes[type];
    }
    return type.split(' ');
  }

  /**
   * Get the list of user-defined environment types
   */
  get environmentTypes(): string[] {
    return Object.keys(this._environmentTypes);
  }

  /**
   * Get the Quetz URL
   */
  get quetzUrl(): string {
    return this._quetzUrl;
  }

  /**
   * Get the Quetz solver URL
   */
  get quetzSolverUrl(): string {
    return this._quetzSolverUrl;
  }

  /**
   * Load user settings
   *
   * @param settings User settings
   */
  private _updateSettings(settings: ISettingRegistry.ISettings): void {
    this._environmentTypes = settings.get('types').composite as IType;
    this._fromHistory = settings.get('fromHistory').composite as boolean;
    this._whitelist = settings.get('whitelist').composite as boolean;
    this._quetzUrl = settings.get('quetzUrl').composite as string;
    this._quetzSolverUrl = settings.get('quetzSolverUrl').composite as string;
  }

  /**
   * Dispose of the resources used by the manager.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    clearInterval(this._environmentsTimer);
    this._clean();
    this._environments.length = 0;
  }

  async getChannels(name: string): Promise<Conda.IChannels> {
    try {
      const request = {
        method: 'GET'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'channels'),
        request
      );
      const response = await promise;
      if (response.ok) {
        const data = await response.json();
        return data['channels'] as Conda.IChannels;
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `Fail to get the channels for environment ${name}.`;
      }
      throw new Error(message);
    }
  }

  async clone(target: string, name: string): Promise<void> {
    try {
      const request: RequestInit = {
        body: JSON.stringify({ name, twin: target }),
        method: 'POST'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments'),
        request
      );
      const response = await promise;

      if (response.ok) {
        this._environmentChanged.emit({
          name: name,
          source: target,
          type: 'clone'
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while cloning environment "${target}".`;
      }
      throw new Error(message);
    }
  }

  async create(name: string, type?: string): Promise<void> {
    try {
      const packages: Array<string> = this.getEnvironmentFromType(type || '');

      const request: RequestInit = {
        body: JSON.stringify({ name, packages }),
        method: 'POST'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments'),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._environmentChanged.emit({
          name: name,
          source: packages,
          type: 'create'
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while creating environment "${name}".`;
      }
      throw new Error(message);
    }
  }

  export(name: string, fromHistory: boolean | null = null): Promise<Response> {
    if (fromHistory === null) {
      fromHistory = this._fromHistory;
    }
    try {
      const request: RequestInit = {
        method: 'GET'
      };
      const args = URLExt.objectToQueryString({
        download: 1,
        history: fromHistory ? 1 : 0
      });
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments', name) + args,
        request
      );
      return promise;
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while exporting environment "${name}".`;
      }
      throw new Error(message);
    }
  }

  async import(
    name: string,
    fileContent: string,
    fileName?: string
  ): Promise<void> {
    try {
      const data: JSONObject = { name, file: fileContent };
      if (fileName) {
        data['filename'] = fileName;
      }
      const request: RequestInit = {
        body: JSON.stringify(data),
        method: 'POST'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments'),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._environmentChanged.emit({
          name: name,
          source: fileContent,
          type: 'import'
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while importing "${name}".`;
      }
      throw new Error(message);
    }
  }

  async refresh(): Promise<Array<Conda.IEnvironment>> {
    try {
      const request: RequestInit = {
        method: 'GET'
      };
      const queryArgs = {
        whitelist: this._whitelist ? 1 : 0
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments') +
          URLExt.objectToQueryString(queryArgs),
        request
      );
      const response = await promise;
      const data = (await response.json()) as RESTAPI.IEnvironments;
      this._environments = data.environments;
      return data.environments;
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = 'An error occurred while listing Conda environments.';
      }
      throw new Error(message);
    }
  }

  async remove(name: string): Promise<void> {
    try {
      const request: RequestInit = {
        method: 'DELETE'
      };
      const { promise } = await Private.requestServer(
        URLExt.join('conda', 'environments', name),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._environmentChanged.emit({
          name: name,
          source: null,
          type: 'remove'
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while removing "${name}".`;
      }
      throw new Error(message);
    }
  }

  async update(
    name: string,
    fileContent: string,
    fileName?: string
  ): Promise<void> {
    try {
      const data: JSONObject = { file: fileContent };
      if (fileName) {
        data['filename'] = fileName;
      }
      const request: RequestInit = {
        body: JSON.stringify(data),
        method: 'PATCH'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments', name),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._environmentChanged.emit({
          name: name,
          source: fileContent,
          type: 'update'
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while updating "${name}".`;
      }
      throw new Error(message);
    }
  }

  async subdir(): Promise<{ subdir: string }> {
    const { promise } = Private.requestServer(
      URLExt.join('conda', 'subdir'),
      {}
    );
    const response = await promise;
    if (response.ok) {
      return response.json();
    } else {
      throw new Error('Error getting subdir');
    }
  }

  // Resolve promise to disconnect signals at disposal
  private _clean: () => void = () => {
    return;
  };
  private _isDisposed = false;
  private _environmentChanged = new Signal<
    IEnvironmentManager,
    Conda.IEnvironmentChange
  >(this);
  private _environments: Array<Conda.IEnvironment>;
  private _environmentsTimer = -1;
  private _environmentTypes: IType = (PageConfig.getOption('types') &&
    JSON.parse(PageConfig.getOption('types'))) || {
    python3: ['python=3', 'ipykernel'],
    r: ['r-base', 'r-essentials']
  };
  private _fromHistory =
    PageConfig.getOption('fromHistory').toLowerCase() === 'true';
  private _packageManager = new CondaPackage();
  private _whitelist =
    PageConfig.getOption('whitelist').toLowerCase() === 'true';
  private _quetzUrl =
    PageConfig.getOption('quetzUrl') || 'http://localhost:8000';
  private _quetzSolverUrl = PageConfig.getOption('quetzSolverUrl');
}

export class CondaPackage implements Conda.IPackageManager {
  /**
   * Conda environment of interest
   */
  environment?: string;

  constructor(environment?: string) {
    this.environment = environment;
  }

  get packageChanged(): ISignal<Conda.IPackageManager, Conda.IPackageChange> {
    return this._packageChanged;
  }

  /**
   * Refresh the package list.
   *
   * @param includeAvailable Include available package list
   * @param environment Environment name
   *
   * @returns The package list
   */
  async refresh(
    includeAvailable = true,
    environment?: string
  ): Promise<Array<Conda.IPackage>> {
    const theEnvironment = environment || this.environment;
    if (theEnvironment === undefined) {
      return Promise.resolve([]);
    }

    this._cancelTasks('default');

    try {
      const request: RequestInit = {
        method: 'GET'
      };

      // Get installed packages
      const { promise, cancel } = Private.requestServer(
        URLExt.join('conda', 'environments', theEnvironment),
        request
      );
      const idx = this._cancellableStack.push({ type: 'default', cancel }) - 1;
      const response = await promise;
      this._cancellableStack.splice(idx, 1);
      const data = (await response.json()) as {
        packages: Array<RESTAPI.IRawPackage>;
      };
      const installedPkgs = data.packages;

      const allPackages: Array<Conda.IPackage> = [];
      if (includeAvailable) {
        // Get all available packages
        allPackages.push(...(await this._getAvailablePackages()));
      }

      // Set installed package status
      //- packages are sorted by name, we take advantage of this.
      const finalList = [];

      let availableIdx = 0;
      let installedIdx = 0;

      while (
        installedIdx < installedPkgs.length ||
        availableIdx < allPackages.length
      ) {
        const installed = installedPkgs[installedIdx];
        let pkg = allPackages[availableIdx] || {
          ...installed,
          version: [installed.version],
          build_number: [installed.build_number],
          build_string: [installed.build_string],
          summary: '',
          home: '',
          keywords: '',
          tags: ''
        };
        pkg.summary = pkg.summary || '';
        // Stringify keywords and tags
        pkg.keywords = (pkg.keywords || '').toString().toLowerCase();
        pkg.tags = (pkg.tags || '').toString().toLowerCase();
        pkg.version_installed = '';
        pkg.version_selected = 'none';
        pkg.updatable = false;

        if (installed !== undefined) {
          if (pkg.name > installed.name) {
            // installed is not in available
            pkg = {
              ...installed,
              version: [installed.version],
              build_number: [installed.build_number],
              build_string: [installed.build_string],
              summary: '',
              home: '',
              keywords: '',
              tags: ''
            };
            availableIdx -= 1;
          }
          if (pkg.name === installed.name) {
            pkg.version_installed = installed.version;
            pkg.version_selected = installed.version;
            if (pkg.version.indexOf(installed.version) < 0) {
              pkg.version.push(installed.version);
            }
            installedIdx += 1;
          }
        }

        // Simplify the package channel name
        const splitUrl = pkg.channel.split('/');
        if (splitUrl.length > 2) {
          let firstNotEmpty = 0;
          if (
            ['http:', 'https:', 'file:'].indexOf(splitUrl[firstNotEmpty]) >= 0
          ) {
            firstNotEmpty = 1; // Skip the scheme http, https or file
          }
          while (splitUrl[firstNotEmpty].length === 0) {
            firstNotEmpty += 1;
          }
          pkg.channel = splitUrl[firstNotEmpty];
          let pos = splitUrl.length - 1;
          while (
            Conda.PkgSubDirs.indexOf(splitUrl[pos]) > -1 &&
            pos > firstNotEmpty
          ) {
            pos -= 1;
          }
          if (pos > firstNotEmpty) {
            pkg.channel += '/...';
          }
          pkg.channel += '/' + splitUrl[pos];
        }

        finalList.push(pkg);
        availableIdx += 1;
      }

      return finalList;
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = 'An error occurred while retrieving available packages.';
      }
      throw new Error(message);
    }
  }

  async install(packages: Array<string>, environment?: string): Promise<void> {
    const theEnvironment = environment || this.environment;
    if (theEnvironment === undefined || packages.length === 0) {
      return Promise.resolve();
    }

    try {
      const request: RequestInit = {
        body: JSON.stringify({ packages }),
        method: 'POST'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments', theEnvironment, 'packages'),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._packageChanged.emit({
          environment: theEnvironment,
          type: 'install',
          packages
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = 'An error occurred while installing packages.';
      }
      throw new Error(message);
    }
  }

  async develop(path: string, environment?: string): Promise<void> {
    const theEnvironment = environment || this.environment;
    if (theEnvironment === undefined || path.length === 0) {
      return Promise.resolve();
    }

    try {
      const request: RequestInit = {
        body: JSON.stringify({ packages: [path] }),
        method: 'POST'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments', theEnvironment, 'packages') +
          URLExt.objectToQueryString({ develop: 1 }),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._packageChanged.emit({
          environment: theEnvironment,
          type: 'develop',
          packages: [path]
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = `An error occurred while installing in development mode package in ${path}.`;
      }
      throw new Error(message);
    }
  }

  async check_updates(environment?: string): Promise<Array<string>> {
    const theEnvironment = environment || this.environment;
    if (theEnvironment === undefined) {
      return Promise.resolve([]);
    }

    this._cancelTasks('default');

    try {
      const request: RequestInit = {
        method: 'GET'
      };
      const { promise, cancel } = Private.requestServer(
        URLExt.join('conda', 'environments', theEnvironment) +
          URLExt.objectToQueryString({ status: 'has_update' }),
        request
      );
      const idx = this._cancellableStack.push({ type: 'default', cancel }) - 1;
      const response = await promise;
      this._cancellableStack.splice(idx, 1);
      const data = (await response.json()) as {
        updates: Array<RESTAPI.IRawPackage>;
      };
      return data.updates.map(pkg => pkg.name);
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = 'An error occurred while checking for package updates.';
      }
      throw new Error(message);
    }
  }

  async update(packages: Array<string>, environment?: string): Promise<void> {
    const theEnvironment = environment || this.environment;
    if (theEnvironment === undefined) {
      return Promise.resolve();
    }

    try {
      const request: RequestInit = {
        body: JSON.stringify({ packages }),
        method: 'PATCH'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments', theEnvironment, 'packages'),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._packageChanged.emit({
          environment: theEnvironment,
          type: 'update',
          packages
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = 'An error occurred while updating packages.';
      }
      throw new Error(message);
    }
  }

  async remove(packages: Array<string>, environment?: string): Promise<void> {
    const theEnvironment = environment || this.environment;
    if (theEnvironment === undefined) {
      return Promise.resolve();
    }

    try {
      const request: RequestInit = {
        body: JSON.stringify({ packages }),
        method: 'DELETE'
      };
      const { promise } = Private.requestServer(
        URLExt.join('conda', 'environments', theEnvironment, 'packages'),
        request
      );
      const response = await promise;
      if (response.ok) {
        this._packageChanged.emit({
          environment: theEnvironment,
          type: 'remove',
          packages
        });
      }
    } catch (error) {
      let message: string = error.message || error.toString();
      if (message !== 'cancelled') {
        console.error(message);
        message = 'An error occurred while removing packages.';
      }
      throw new Error(message);
    }
  }

  async getDependencies(
    pkg: string,
    cancellable = true
  ): Promise<Conda.IPackageDeps> {
    this._cancelTasks('getDependencies');

    const request: RequestInit = {
      method: 'GET'
    };

    const { promise, cancel } = Private.requestServer(
      URLExt.join('conda', 'packages') +
        URLExt.objectToQueryString({ dependencies: 1, query: pkg }),
      request
    );

    let idx: number;
    if (cancellable) {
      idx =
        this._cancellableStack.push({ type: 'getDependencies', cancel }) - 1;
    }

    const response = await promise;
    if (idx) {
      this._cancellableStack.splice(idx, 1);
    }
    const data = (await response.json()) as Conda.IPackageDeps;
    return Promise.resolve(data);
  }

  async refreshAvailablePackages(cancellable = true): Promise<void> {
    await this._getAvailablePackages(true, cancellable);
  }

  /**
   * Does the available packages have description?
   *
   * @returns description presence
   */
  hasDescription(): boolean {
    return CondaPackage._hasDescription;
  }

  /**
   * Get the available packages list.
   *
   * @param force Force refreshing the available package list
   * @param cancellable Can this asynchronous action be cancelled?
   */
  private async _getAvailablePackages(
    force = false,
    cancellable = true
  ): Promise<Array<Conda.IPackage>> {
    this._cancelTasks('default');

    if (CondaPackage._availablePackages === null || force) {
      const request: RequestInit = {
        method: 'GET'
      };

      const { promise, cancel } = Private.requestServer(
        URLExt.join('conda', 'packages'),
        request
      );
      let idx: number;
      if (cancellable) {
        idx = this._cancellableStack.push({ type: 'default', cancel }) - 1;
      }
      const response = await promise;
      if (idx) {
        this._cancellableStack.splice(idx, 1);
      }
      const data = (await response.json()) as {
        packages: Array<Conda.IPackage>;
        with_description: boolean;
      };
      CondaPackage._availablePackages = data.packages;
      CondaPackage._hasDescription = data.with_description || false;
    }
    return Promise.resolve(CondaPackage._availablePackages);
  }

  /**
   * Cancel optional tasks
   */
  private _cancelTasks(type: string): void {
    if (this._cancellableStack.length > 0) {
      const tasks = this._cancellableStack.splice(
        0,
        this._cancellableStack.length
      );
      tasks.forEach(action => {
        if (action.type === type) {
          action.cancel();
        }
      });
    }
  }

  private _packageChanged: Signal<
    CondaPackage,
    Conda.IPackageChange
  > = new Signal<this, Conda.IPackageChange>(this);
  private _cancellableStack: Array<ICancellableAction> = [];
  private static _availablePackages: Array<Conda.IPackage> = null;
  private static _hasDescription = false;
}

namespace Private {
  /**
   * Polling interval for accepted tasks
   */
  const POLLING_INTERVAL = 1000;

  export interface ICancellablePromise<T> {
    promise: Promise<T>;
    cancel: () => void;
  }

  /** Helper functions to carry on python notebook server request
   *
   * @param {string} url : request url
   * @param {RequestInit} request : initialization parameters for the request
   * @returns {ICancellablePromise<Response>} : Cancellable response to the request
   */
  export const requestServer = function (
    url: string,
    request: RequestInit
  ): ICancellablePromise<Response> {
    const settings = ServerConnection.makeSettings();
    const fullUrl = URLExt.join(settings.baseUrl, url);

    let answer: ICancellablePromise<Response>;
    let cancelled = false;

    const promise = new PromiseDelegate<Response>();

    ServerConnection.makeRequest(fullUrl, request, settings)
      .then(response => {
        if (!response.ok) {
          response
            .json()
            .then(body =>
              promise.reject(
                new ServerConnection.ResponseError(response, body.error)
              )
            )
            .catch(reason => {
              console.error(
                'Fail to read JSON response for request',
                request,
                reason
              );
            });
        } else if (response.status === 202) {
          const redirectUrl = response.headers.get('Location') || url;

          setTimeout(
            (url: string, settings: RequestInit) => {
              if (cancelled) {
                // If cancelled, tell the backend to delete the task.
                console.debug(`Request cancelled ${url}.`);
                settings = { ...settings, method: 'DELETE' };
              }
              answer = requestServer(url, settings);
              answer.promise
                .then(response => promise.resolve(response))
                .catch(reason => promise.reject(reason));
            },
            POLLING_INTERVAL,
            redirectUrl,
            { method: 'GET' }
          );
        } else {
          promise.resolve(response);
        }
      })
      .catch(reason => {
        promise.reject(new ServerConnection.NetworkError(reason));
      });

    return {
      promise: promise.promise,
      cancel: (): void => {
        cancelled = true;
        if (answer) {
          answer.cancel();
        }
        promise.reject('cancelled');
      }
    };
  };
}
