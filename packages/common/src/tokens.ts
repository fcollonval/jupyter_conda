import { Token } from '@lumino/coreutils';
import { IDisposable } from '@lumino/disposable';
import { ISignal } from '@lumino/signaling';

export const IEnvironmentManager = new Token<IEnvironmentManager>(
  '@mamba-org/gator-lab:IEnvironmentManager'
);

/**
 * Interface for the environment manager
 */
export interface IEnvironmentManager extends IDisposable {
  /**
   * Get all available environments
   */
  environments: Promise<Array<Conda.IEnvironment>>;
  /**
   * Get the list of user-defined environment types
   */
  environmentTypes: string[];

  /**
   * Get the Quetz URL
   */
  quetzUrl: string;

  /**
   * Get the Quetz solver URL
   */
  quetzSolverUrl: string;

  /**
   * Get all packages channels available in the requested environment
   *
   * @param name environment name
   */
  getChannels(name: string): Promise<Conda.IChannels>;
  /**
   * Get packages manager for the given environment
   *
   * @param name name of the environment to work with
   */
  getPackageManager(name?: string): Conda.IPackageManager;
  /**
   * Duplicate a given environment
   *
   * @param target name of the environment to be cloned
   * @param name name of the new environment
   */
  clone(target: string, name: string): Promise<void>;
  /**
   * Create a new environment
   *
   * @param name name of the new environment
   * @param type type of environment to create
   */
  create(name: string, type?: string): Promise<void>;
  /**
   * Signal emitted when a environment is changed.
   */
  environmentChanged: ISignal<IEnvironmentManager, Conda.IEnvironmentChange>;
  /**
   * Export the packages list of an environment
   *
   * @param name Name of the environment to be exported
   * @param fromHistory Whether to export only from the history
   */
  export(name: string, fromHistory?: boolean): Promise<Response>;
  /**
   * Create an environment from a packages list file
   *
   * @param name name of the environment to create
   * @param fileContent file content of the file containing the packages list to import
   */
  import(name: string, fileContent: string, fileName?: string): Promise<void>;
  /**
   * Create an environment from a packages list file
   *
   * @param name name of the environment to create
   * @param fileContent file content of the file containing the packages list to import
   * @param fileName
   */
  update(name: string, fileContent: string, fileName: string): Promise<void>;
  /**
   * Remove a given environment
   *
   * @param name name of the environment to be removed
   */
  remove(name: string): Promise<void>;
  /**
   * Get the conda-subdir of the server
   */
  subdir(): Promise<{ subdir: string }>;
}

export namespace Conda {
  /**
   * Description of the REST API response for each environment
   */
  export interface IEnvironment {
    /**
     * Environment name
     */
    name: string;
    /**
     * Environment path
     */
    dir: string;
    /**
     * Is the environment the default one
     */
    is_default: boolean;
  }

  export interface IEnvironmentChange {
    /**
     * Name of the created environment
     */
    name: string;
    /**
     * Method of environment creation
     */
    type: 'clone' | 'create' | 'import' | 'remove' | 'update';
    /**
     * Source used for the environment action
     *   'create' -> Initial package list
     *   'import' -> Package list imported
     *   'clone' -> Name of the environment cloned
     *   'remove' -> null
     *   'update' -> Update environment
     */
    source: string | string[] | null;
  }

  /**
   * Description of the REST API response when requesting the channels
   */
  export interface IChannels {
    /**
     * Mapping channel name and associated URI
     */
    [key: string]: Array<string>;
  }

  /**
   * Interface of the packages service
   */
  export interface IPackageManager {
    /**
     * Environment in which packages are handled
     *
     * TODO remove => better use mandatory environment in args
     */
    environment?: string;
    /**
     * Refresh packages list of the environment
     *
     * @param includeAvailable Include available package list (default true)
     * @param environment Environment name
     */
    refresh(
      includeAvailable?: boolean,
      environment?: string
    ): Promise<Array<Conda.IPackage>>;
    /**
     * Refresh available package list
     *
     * @param cancellable Whether allowing this request to be cancelled or not?
     */
    refreshAvailablePackages(cancellable?: boolean): Promise<void>;
    /**
     * Does the packages have description?
     */
    hasDescription(): boolean;
    /**
     * Install packages
     *
     * @param packages List of packages to be installed
     * @param environment Environment name
     */
    install(packages: Array<string>, environment?: string): Promise<void>;
    /**
     * Install a package in development mode
     *
     * @param path Path to the package to install in development mode
     * @param environment Environment name
     */
    develop(path: string, environment?: string): Promise<void>;
    /**
     * Check for updates
     *
     * @returns List of updatable packages
     * @param environment Environment name
     */
    check_updates(environment?: string): Promise<Array<string>>;
    /**
     * Update packages
     *
     * @param packages List of packages to be updated
     * @param environment Environment name
     */
    update(packages: Array<string>, environment?: string): Promise<void>;
    /**
     * Remove packages
     *
     * @param packages List of packages to be removed
     * @param environment Environment name
     */
    remove(packages: Array<string>, environment?: string): Promise<void>;
    /**
     * Get packages dependencies list.
     *
     * @param package Package name
     * @param cancellable Can this asynchronous action be cancelled?
     *
     * @returns The package list
     */
    getDependencies(
      pkg: string,
      cancellable: boolean
    ): Promise<Conda.IPackageDeps>;
    /**
     * Signal emitted when some package actions are executed.
     */
    packageChanged: ISignal<IPackageManager, Conda.IPackageChange>;
  }

  /**
   * Available platforms subpackages
   */
  export const PkgSubDirs = [
    'linux-64',
    'linux-32',
    'linux-ppc64le',
    'linux-armv6l',
    'linux-armv7l',
    'linux-aarch64',
    'win-64',
    'win-32',
    'osx-64',
    'zos-z',
    'noarch'
  ];

  /**
   * Description of the REST API attributes for each package
   */
  export interface IPackage {
    name: string;
    version: Array<string>;
    build_number: Array<number>;
    build_string: Array<string>;
    channel: string;
    platform: string;
    summary: string;
    home: string;
    keywords: string;
    tags: string;
    version_installed?: string;
    version_selected?: string;
    updatable?: boolean;
  }
  /**
   * Packages dependencies
   */
  export interface IPackageDeps {
    [package_name: string]: string[];
  }

  export interface IPackageChange {
    /**
     * Name of the environment changed
     */
    environment: string;
    /**
     * Package action
     */
    type: 'develop' | 'install' | 'update' | 'remove';
    /**
     * Packages modified
     */
    packages: string[];
  }
}
