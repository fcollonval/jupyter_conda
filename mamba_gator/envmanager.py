# Copyright (c) 2016-2020 Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.
import asyncio
import collections
import json
import logging
import os
import re
import sys
import tempfile
from functools import partial, lru_cache
from pathlib import Path
from subprocess import PIPE, Popen
from typing import Any, Dict, List, Optional, Tuple, Union

import tornado
from jupyter_client.kernelspec import KernelSpecManager

from packaging.version import parse

try:
    import nb_conda_kernels
except ImportError:
    nb_conda_kernels = None

from .log import get_logger
from jupyter_server.utils import url2path, url_path_join


CONDA_EXE = os.environ.get("CONDA_EXE", "conda")  # type: str

PATH_SEP = "\\" + os.path.sep
CONDA_ENV_PATH = r"^(.*?" + PATH_SEP + r"envs" + PATH_SEP + r".+?)" + PATH_SEP

# try to match lines of json
JSONISH_RE = r'(^\s*["\{\}\[\],\d])|(["\}\}\[\],\d]\s*$)'  # type: str

MAX_LOG_OUTPUT = 6000  # type: int

ROOT_ENV_NAME = "base"

# See https://github.com/Anaconda-Platform/nb_conda_kernels/blob/master/nb_conda_kernels/manager.py#L19
try:
    RUNNER_COMMAND = nb_conda_kernels.manager.RUNNER_COMMAND
except AttributeError:
    RUNNER_COMMAND = ["python", "-m", "nb_conda_kernels.runner"]


def normalize_pkg_info(s: Dict[str, Any]) -> Dict[str, Union[str, List[str]]]:
    """Normalize package information.

    Args:
        s (dict): Raw package information

    Returns:
        dict: Normalized package information
    """
    return {
        "build_number": s.get("build_number"),
        "build_string": s.get("build_string", s.get("build")),
        "channel": s.get("channel"),
        "name": s.get("name"),
        "platform": s.get("platform"),
        "version": s.get("version"),
        "summary": s.get("summary", ""),
        "home": s.get("home", ""),
        "keywords": s.get("keywords", []),
        "tags": s.get("tags", []),
    }


def get_env_path(kernel_spec: Dict[str, Any]) -> Optional[str]:
    """Get the conda environment path.

    Args:
        kernel_spec (dict): Kernel spec

    Returns:
        str: Best guess for the environment path
    """
    argv = kernel_spec.get("argv", [])
    if "conda_env_path" in kernel_spec["metadata"]:
        return kernel_spec["metadata"]["conda_env_path"]
    elif len(argv) >= 5 and argv[:3] == RUNNER_COMMAND and len(argv[4]) > 0:
        return argv[4]
    elif len(argv) > 0:
        match = re.match(CONDA_ENV_PATH, argv[0])
        if match is not None:
            return match.groups()[0]

    return None


class EnvManager:
    """Handles environment and package actions."""

    _conda_version: Optional[str] = None
    _mamba_version: Optional[str] = None
    _manager_exe: Optional[str] = None

    def __init__(self, root_dir: str, kernel_spec_manager: KernelSpecManager):
        """
        Args:
            root_dir (str): Server root path
        """
        self._root_dir = root_dir
        self._kernel_spec_manager = kernel_spec_manager

    def _clean_conda_json(self, output: str) -> Dict[str, Any]:
        """Clean a command output to fit json format.

        Args:
            output (str): output to clean

        Returns:
            Dict[str, Any]: Cleaned output
        """
        lines = output.splitlines()

        try:
            return json.loads("\n".join(lines))
        except (ValueError, json.JSONDecodeError) as err:
            self.log.warn("JSON parse fail:\n{!s}".format(err))

        # try to remove bad lines
        lines = [line for line in lines if re.match(JSONISH_RE, line)]

        try:
            return json.loads("\n".join(lines))
        except (ValueError, json.JSONDecodeError) as err:
            self.log.error("JSON clean/parse fail:\n{!s}".format(err))

        return {"error": True}

    async def _execute(self, cmd: str, *args) -> Tuple[int, str]:
        """Asynchronously execute a command.

        Args:
            cmd (str): command to execute
            *args: additional command arguments

        Returns:
            (int, str): (return code, output) or (return code, error)
        """
        cmdline = [cmd]
        cmdline.extend(args)

        self.log.debug("command: {!s}".format(" ".join(cmdline)))

        current_loop = tornado.ioloop.IOLoop.current()
        process = await current_loop.run_in_executor(
            None, partial(Popen, cmdline, stdout=PIPE, stderr=PIPE)
        )
        try:
            output, error = await current_loop.run_in_executor(
                None, process.communicate
            )
        except asyncio.CancelledError:
            process.terminate()
            await current_loop.run_in_executor(None, process.wait)
            raise

        returncode = process.returncode
        if returncode == 0:
            output = output.decode("utf-8")
        else:
            self.log.debug("exit code: {!s}".format(returncode))
            output = error.decode("utf-8") + output.decode("utf-8")

        self.log.debug("output: {!s}".format(output[:MAX_LOG_OUTPUT]))

        if len(output) > MAX_LOG_OUTPUT:
            self.log.debug("...")

        return returncode, output

    @property
    def log(self) -> logging.Logger:
        """logging.Logger : Extension logger"""
        return get_logger()

    @property
    def manager(self) -> str:
        """Conda package manager name.

        For now, use mamba if it is installed. Otherwise, fallback to conda.

        Returns:
            str: Package manager
        """
        if EnvManager._manager_exe is None:
            # Set conda by default
            EnvManager._manager_exe = CONDA_EXE
            try:
                cmd = ["which", "mamba"]
                if sys.platform == "win32":
                    cmd = ["where", "mamba.exe"]

                process = Popen(
                    cmd, stdout=PIPE, stderr=PIPE, encoding="utf-8"
                )
                output, error = process.communicate()

                if process.returncode != 0:
                    raise RuntimeError(error)

                mamba_exe = output.splitlines()[0] or "mamba"

                process = Popen(
                    [mamba_exe, "--version"],
                    stdout=PIPE,
                    stderr=PIPE,
                    encoding="utf-8",
                )
                output, error = process.communicate()

                if process.returncode != 0:
                    raise RuntimeError(error)

                versions = list(map(lambda l: l.split(), output.splitlines()))
                if versions[0][0] == "mamba" and versions[1][0] == "conda":
                    EnvManager._conda_version = versions[1][1]
                    EnvManager._mamba_version = versions[0][1]
                    EnvManager._manager_exe = mamba_exe

            except BaseException:
                self.log.debug(
                    "Fail to get mamba version, falling back to conda",
                    exc_info=sys.exc_info(),
                )

            self.log.debug("Package manager: {}".format(EnvManager._manager_exe))

        return EnvManager._manager_exe

    @lru_cache()
    def is_mamba(self):
        return Path(self.manager).stem == "mamba"

    async def env_channels(
        self, configuration: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Dict[str, List[str]]]:
        """List available channels.

        Args:
            configuration (Dict[str, Any] or None): Conda configuration

        Returns:
            {"channels": {<channel>: <uri>}}
        """
        if configuration is None:
            info = await self.conda_config()
        else:
            info = configuration

        if "error" in info:
            return info

        deployed_channels = {}

        def get_uri(spec):
            location = "/".join((spec["location"], spec["name"]))
            return spec["scheme"] + "://" + location

        for channel in info["channels"]:
            strip_channel = channel.strip("/")
            if channel in info["custom_multichannels"]:
                deployed_channels[channel] = [
                    get_uri(entry) for entry in info["custom_multichannels"][channel]
                ]
            elif strip_channel in info["custom_channels"]:
                deployed_channels[strip_channel] = [
                    get_uri(info["custom_channels"][strip_channel])
                ]
            else:
                parsed_channel = tornado.httputil.urlparse(channel)
                if parsed_channel.scheme:
                    deployed_channels[strip_channel] = [
                        channel.strip("/"),
                    ]
                else:
                    spec = info["channel_alias"]
                    spec["name"] = channel
                    deployed_channels[channel] = [
                        get_uri(spec),
                    ]

        self.log.debug("channels: {}".format(deployed_channels))
        return {"channels": deployed_channels}

    async def conda_config(self) -> Dict[str, Any]:
        """Get conda configuration.

        Returns:
            Dict[str, Any]: Conda configuration
        """
        ans = await self._execute(CONDA_EXE, "config", "--show", "--json")
        _, output = ans
        return self._clean_conda_json(output)

    async def clone_env(self, env: str, name: str) -> Dict[str, str]:
        """Clone an environment.

        Args:
            env (str): To-be-cloned environment name
            name (str): New environment name

        Returns:
            Dict[str, str]: Clone command output.
        """
        ans = await self._execute(
            self.manager, "create", "-y", "-q", "--json", "-n", name, "--clone", env
        )

        rcode, output = ans
        if rcode > 0:
            return {"error": output}
        return output

    async def create_env(self, env: str, *args) -> Dict[str, str]:
        """Create a environment from a list of packages.

        Args:
            env (str): Name of the environment
            *args (List[str]): optional, packages to install

        Returns:
            Dict[str, str]: Create command output
        """
        ans = await self._execute(
            self.manager, "create", "-y", "-q", "--json", "-n", env, *args
        )

        rcode, output = ans
        if rcode > 0:
            return {"error": output}
        return output

    async def delete_env(self, env: str) -> Dict[str, str]:
        """Delete an environment.

        Args:
            env (str): Environment name

        Returns:
            Dict[str, str]: Deletion command output
        """
        ans = await self._execute(
            self.manager, "env", "remove", "-y", "-q", "--json", "-n", env
        )

        rcode, output = ans
        if rcode > 0:
            return {"error": output}
        return output

    async def export_env(
        self, env: str, from_history: bool = False
    ) -> Union[str, Dict[str, str]]:
        """Export an environment as YAML file.

        Args:
            env (str): Environment name
            from_history (bool): If True, use `--from-history` option; default False

        Returns:
            str: YAML file content
        """
        command = [self.manager, "env", "export", "-n", env]
        if from_history:
            if EnvManager._conda_version is None:
                await self.info()  # Set conda version
            if EnvManager._conda_version < (4, 7, 12):
                self.log.warning(
                    "conda<4.7.12 does not support `env export --from-history`. It will be ignored."
                )
            else:
                command.append("--from-history")
        ans = await self._execute(*command)
        rcode, output = ans
        if rcode > 0:
            return {"error": output}
        return output

    async def import_env(
        self, env: str, file_content: str, file_name: str = "environment.txt"
    ) -> Dict[str, str]:
        """Create an environment from a file.

        Args:
            env (str): Environment name
            file_content (str): File content
            file_name (str): optional, Original filename

        Returns:
            Dict[str, str]: Create command output
        """
        regex = re.compile('^@EXPLICIT$', re.MULTILINE)
        is_explicit_list = regex.search(file_content)

        env_argument = [] if is_explicit_list else ["env"]

        with tempfile.NamedTemporaryFile(mode="w", suffix=file_name) as f:
            name = f.name
            f.write(file_content)
            f.flush()

            ans = await self._execute(
                self.manager, *env_argument, "create", "-q", "--json", "-n", env, "--file", name
            )

        rcode, output = ans
        if rcode > 0:
            return {"error": output}
        return output

    async def info(self) -> Dict[str, Any]:
        """Returns `conda info --json` execution.

        Returns:
            The dictionary of conda information
        """
        ans = await self._execute(self.manager, "info", "--json")
        rcode, output = ans
        info = self._clean_conda_json(output)
        if rcode == 0:
            EnvManager._conda_version = tuple(
                map(
                    lambda part: int(part),
                    info.get("conda_version", EnvManager._conda_version).split("."),
                )
            )
        return info

    async def list_envs(
        self, whitelist: bool = False
    ) -> Dict[str, List[Dict[str, Union[str, bool]]]]:
        """List all environments that conda knows about.

        Args:
            whitelist (bool): optional, filter the environment list to respect
                KernelSpecManager.whitelist (default: False)

        An environment is described by a dictionary:
        {
            name (str): environment name,
            dir (str): environment prefix,
            is_default (bool): is the root environment
        }

        Returns:
            {"environments": List[env]}: The environments
        """
        info = await self.info()
        if "error" in info:
            return info

        default_env = info["default_prefix"]

        root_env = {
            "name": ROOT_ENV_NAME,
            "dir": info["root_prefix"],
            "is_default": info["root_prefix"] == default_env,
        }

        whitelist_env = set()
        if whitelist:
            # Build env path list - simplest way to compare kernel and environment
            for entry in self._kernel_spec_manager.get_all_specs().values():
                path = get_env_path(entry["spec"])
                if path:
                    whitelist_env.add(path)

        def get_info(env):
            base_dir = os.path.dirname(env)
            if base_dir not in info["envs_dirs"]:
                return None

            return {
                "name": os.path.basename(env),
                "dir": env,
                "is_default": env == default_env,
            }

        envs_list = [root_env]
        for env in info["envs"]:
            env_info = get_info(env)
            if env_info is not None and (
                len(whitelist_env) == 0 or env_info["dir"] in whitelist_env
            ):
                envs_list.append(env_info)

        return {"environments": envs_list}

    async def update_env(
        self, env: str, file_content: str, file_name: str = "environment.yml"
    ) -> Dict[str, str]:
        """Update a environment from a file.

        Args:
            env (str): Name of the environment
            file_content (str): File content
            file_name (str): optional, Original filename

        Returns:
            Dict[str, str]: Create command output
        """
        with tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=file_name) as f:
            name = f.name
            f.write(file_content)

        ans = await self._execute(
            self.manager, "env", "update", "-q", "--json", "-n", env, "-f", name
        )

        rcode, output = ans
        if rcode > 0:
            return {"error": output}
        return output

    async def env_packages(self, env: str) -> Dict[str, List[str]]:
        """List environment package.

        Args:
            env (str): Environment name

        Returns:
            {"packages": List[package]}
        """
        ans = await self._execute(self.manager, "list", "--no-pip", "--json", "-n", env)
        _, output = ans
        data = self._clean_conda_json(output)

        # Data structure
        #   List of dictionary. Example:
        # {
        #     "base_url": null,
        #     "build_number": 0,
        #     "build_string": "py36_0",
        #     "channel": "defaults",
        #     "dist_name": "anaconda-client-1.6.14-py36_0",
        #     "name": "anaconda-client",
        #     "platform": null,
        #     "version": "1.6.14"
        # }

        if "error" in data:
            # we didn't get back a list of packages, we got a dictionary with
            # error info
            return data

        return {"packages": [normalize_pkg_info(package) for package in data]}

    async def pkg_depends(self, pkg: str) -> Dict[str, List[str]]:
        """List environment packages dependencies.

        Args:
            pkg (str): Package name

        Returns:
            {"package": List[dependencies]}
        """
        if not self.is_mamba():
            self.log.warning(
                "Package manager '{}' does not support dependency query.".format(
                    self.manager
                )
            )
            return {pkg: None}

        resp = {}
        ans = await self._execute(self.manager, "repoquery", "depends", "--json", pkg)
        _, output = ans
        query = self._clean_conda_json(output)

        if "error" not in query:
            for dep in query["result"]["pkgs"]:
                if type(dep) is dict:
                    deps = dep.get("depends", None)
                    if deps:
                        resp[dep["name"]] = deps
                    else:
                        resp[dep["name"]] = []

        return resp

    async def list_available(self) -> Dict[str, List[Dict[str, str]]]:
        """List all available packages

        Returns:
            {
                "packages": List[package],
                "with_description": bool  # Whether we succeed in get some channeldata.json files
            }
        """
        if self.is_mamba():
            ans = await self._execute(self.manager, "repoquery", "search", "*", "--json")
        else:
            ans = await self._execute(self.manager, "search", "--json")
        _, output = ans

        current_loop = tornado.ioloop.IOLoop.current()
        data = await current_loop.run_in_executor(None, self._clean_conda_json, output)

        if "error" in data:
            # we didn't get back a list of packages, we got a
            # dictionary with error info
            return data

        def process_mamba_repoquery_output(data: Dict) -> Dict:
            """Make a dictionary with keys as packages name and values
            containing the list of available packages to match the json output
            of "conda search --json".
            """

            data_ = collections.defaultdict(lambda : [])
            for entry in data['result']['pkgs']:
                name = entry.get('name')
                if name is not None:
                    data_[name].append(entry)

            return data_

        if self.is_mamba():
            data = await current_loop.run_in_executor(None, process_mamba_repoquery_output, data)

        def format_packages(data: Dict) -> List:
            packages = []

            # Data structure
            #  Dictionary with package name key and value is a list of dictionary. Example:
            #  {
            #   "arch": "x86_64",
            #   "build": "np17py33_0",
            #   "build_number": 0,
            #   "channel": "https://repo.anaconda.com/pkgs/free/win-64",
            #   "constrains": [],
            #   "date": "2013-02-20",
            #   "depends": [
            #     "numpy 1.7*",
            #     "python 3.3*"
            #   ],
            #   "fn": "astropy-0.2-np17py33_0.tar.bz2",
            #   "license": "BSD",
            #   "md5": "3522090a8922faebac78558fbde9b492",
            #   "name": "astropy",
            #   "platform": "win32",
            #   "size": 3352442,
            #   "subdir": "win-64",
            #   "url": "https://repo.anaconda.com/pkgs/free/win-64/astropy-0.2-np17py33_0.tar.bz2",
            #   "version": "0.2"
            # }

            # List all available version for packages
            for entries in data.values():
                pkg_entry = None
                versions = list()
                max_build_numbers = list()
                max_build_strings = list()

                for entry in entries:
                    entry = normalize_pkg_info(entry)
                    if pkg_entry is None:
                        pkg_entry = entry

                    version = parse(entry.get("version", ""))

                    if version not in versions:
                        versions.append(version)
                        max_build_numbers.append(entry.get("build_number", 0))
                        max_build_strings.append(entry.get("build_string", ""))
                    else:
                        version_idx = versions.index(version)
                        build_number = entry.get("build_number", 0)
                        if build_number > max_build_numbers[version_idx]:
                            max_build_numbers[version_idx] = build_number
                            max_build_strings[version_idx] = entry.get(
                                "build_string", ""
                            )

                sorted_versions_idx = sorted(
                    range(len(versions)), key=versions.__getitem__
                )

                pkg_entry["version"] = [str(versions[i]) for i in sorted_versions_idx]
                pkg_entry["build_number"] = [
                    max_build_numbers[i] for i in sorted_versions_idx
                ]
                pkg_entry["build_string"] = [
                    max_build_strings[i] for i in sorted_versions_idx
                ]

                packages.append(pkg_entry)
            return packages

        packages = await current_loop.run_in_executor(None, format_packages, data)

        # Get channel short names
        configuration = await self.conda_config()
        channels = await self.env_channels(configuration)
        channels = channels["channels"]
        tr_channels = {}
        for short_name, channel in channels.items():
            tr_channels.update({uri: short_name for uri in channel})

        # # Get top channel URI to request channeldata.json
        # top_channels = set()
        # for uri in tr_channels:
        #     channel, arch = os.path.split(uri)
        #     if arch in PLATFORMS:
        #         top_channels.add(channel)
        #     else:
        #         top_channels.add(uri)

        # Request channeldata.json
        pkg_info = {}
        client = tornado.httpclient.AsyncHTTPClient(force_instance=True)
        for channel in tr_channels:
            url = tornado.httputil.urlparse(channel)
            if url.scheme == "file":
                if url.netloc:
                    path = "".join(("//", url.netloc, url.path))
                elif sys.platform == "win32":
                    path = url.path.lstrip("/")
                else:
                    path = url.path
                path = os.path.join(path, "channeldata.json")
                self.log.debug("Reading {}".format(path))
                try:  # Skip if file is not accessible
                    with open(path) as f:
                        channeldata = json.load(f)
                except (json.JSONDecodeError, OSError, ValueError) as err:
                    self.log.info("{!s} skipped".format(path))
                    self.log.debug(str(err))
                else:
                    pkg_info.update(channeldata["packages"])
            else:
                try:  # Skip if file is not accessible
                    response = await client.fetch(
                        tornado.httpclient.HTTPRequest(
                            url_path_join(channel, "channeldata.json"),
                            headers={"Content-Type": "application/json"},
                            validate_cert=configuration.get("ssl_verify", True),
                        )
                    )
                except Exception as e:
                    self.log.info("{}/channeldata.json skipped.".format(channel))
                    self.log.debug(str(e))
                else:
                    channeldata = response.body.decode("utf-8")
                    try:
                        pkg_info.update(json.loads(channeldata)["packages"])
                    except (json.JSONDecodeError, ValueError) as error:
                        self.log.info("{}/channeldata.json skipped.".format(channel))
                        self.log.debug(str(error))

        # Example structure channeldata['packages'] for channeldata_version == 1
        # "tmpc0d7d950": {
        #     "activate.d": false,
        #     "binary_prefix": false,
        #     "deactivate.d": false,
        #     "identifiers": [],
        #     "keywords": [
        #         "['package', 'tmpc0d7d950']"
        #     ],
        #     "license": "MIT",
        #     "post_link": false,
        #     "pre_link": false,
        #     "pre_unlink": false,
        #     "reference_package": "win-64/tmpc0d7d950-0.1.0.dev1-py36_0.tar.bz2",
        #     "run_exports": {},
        #     "subdirs": [
        #         "win-64"
        #     ],
        #     "summary": "Dummy package",
        #     "tags": [],
        #     "text_prefix": false,
        #     "version": "0.1.0.dev1"
        # }

        def update_packages(packages, pkg_info, tr_channels):
            # Update channel and add some info
            for package in packages:
                name = package["name"]
                if name in pkg_info:
                    package["summary"] = pkg_info[name].get("summary", "")
                    package["home"] = pkg_info[name].get("home", "")
                    # May return None so "or" with empty list
                    package["keywords"] = pkg_info[name].get("keywords", []) or []
                    package["tags"] = pkg_info[name].get("tags", []) or []

                # Convert to short channel names
                channel, _ = os.path.split(package["channel"])
                if channel in tr_channels:
                    package["channel"] = tr_channels[channel]

            return sorted(packages, key=lambda entry: entry.get("name"))

        packages = await current_loop.run_in_executor(
            None, update_packages, packages, pkg_info, tr_channels
        )

        return {
            "packages": packages,
            "with_description": len(pkg_info) > 0,
        }

    async def package_search(self, q: str) -> Dict[str, List]:
        """Search packages.

        Args:
            q (str): Search query

        Returns:
            {
                "packages": List[package],
                "with_description": bool  # Whether we succeed in get some channeldata.json files
            }
        """
        ans = await self._execute(self.manager, "search", "--json", q)
        _, output = ans
        data = self._clean_conda_json(output)

        if "error" in data:
            # we didn't get back a list of packages, we got a dictionary with
            # error info
            return data

        packages = []

        for entries in data.values():
            max_version = None
            max_version_entry = None

            for entry in entries:
                version = parse(entry.get("version", ""))

                if max_version is None or version > max_version:
                    max_version = version
                    max_version_entry = entry

            packages.append(max_version_entry)

        return {
            "packages": sorted(packages, key=lambda entry: entry.get("name")),
            "with_description": False,
        }

    async def check_update(
        self, env: str, packages: List[str]
    ) -> Dict[str, List[Dict[str, str]]]:
        """Check for packages update in an environment.

        if '--all' is the only element in `packages`, search for all
        possible update in the given environment.

        Args:
            env (str): Environment name
            packages (List[str]): List of packages to search for update

        Returns:
            {"updates": List[package]}
        """
        ans = await self._execute(
            self.manager, "update", "--dry-run", "-q", "--json", "-n", env, *packages
        )
        _, output = ans
        data = self._clean_conda_json(output)

        # Data structure in LINK
        #   List of dictionary. Example:
        # {
        #     "base_url": null,
        #     "build_number": 0,
        #     "build_string": "mkl",
        #     "channel": "defaults",
        #     "dist_name": "blas-1.0-mkl",
        #     "name": "blas",
        #     "platform": null,
        #     "version": "1.0"
        # }

        if "error" in data:
            # we didn't get back a list of packages, we got a dictionary with
            # error info
            return data
        elif "actions" in data:
            links = data["actions"].get("LINK", [])
            package_versions = [link for link in links]
            return {
                "updates": [
                    normalize_pkg_info(pkg_version) for pkg_version in package_versions
                ]
            }
        else:
            # no action plan returned means everything is already up to date
            return {"updates": []}

    async def install_packages(self, env: str, packages: List[str]) -> Dict[str, str]:
        """Install packages in an environment.

        Args:
            env (str): Environment name
            packages (List[str]): List of packages to install

        Returns:
            Dict[str, str]: Install command output.
        """
        ans = await self._execute(
            self.manager, "install", "-y", "-q", "--json", "-n", env, *packages
        )
        _, output = ans
        return self._clean_conda_json(output)

    async def develop_packages(
        self, env: str, packages: List[str]
    ) -> Dict[str, List[Dict[str, str]]]:
        """Install packages in pip editable mode in an environment.

        Args:
            env (str): Environment name
            packages (List[str]): List of packages to install

        Returns:
            Dict[str, str]: Install command output.
        """
        envs = await self.list_envs()
        if "error" in envs:
            return envs

        env_rootpath = None
        for e in envs["environments"]:
            if e["name"] == env:
                env_rootpath = e
                break

        result = []
        if env_rootpath:
            if sys.platform == "win32":
                python_cmd = os.path.join(env_rootpath["dir"], "python")
            else:
                python_cmd = os.path.join(env_rootpath["dir"], "bin", "python")

            for path in packages:
                realpath = os.path.realpath(os.path.expanduser(path))
                if not os.path.exists(realpath):
                    # Convert jupyterlab path to local path if the path does not exists
                    realpath = os.path.realpath(
                        os.path.join(self._root_dir, url2path(path))
                    )
                    if not os.path.exists(realpath):
                        return {"error": "Unable to find path {}.".format(path)}

                ans = await self._execute(
                    python_cmd,
                    "-m",
                    "pip",
                    "install",
                    "--progress-bar",
                    "off",
                    "-e",
                    realpath,
                )
                rcode, output = ans
                if rcode > 0:
                    return {"error": output}
                feedback = {"path": path, "output": output}
                result.append(feedback)
        return {"packages": result}

    async def update_packages(self, env: str, packages: List[str]) -> Dict[str, str]:
        """Update packages in an environment.

        Args:
            env (str): Environment name
            packages (List[str]): List of packages to update

        Returns:
            Dict[str, str]: Update command output.
        """
        ans = await self._execute(
            self.manager, "update", "-y", "-q", "--json", "-n", env, *packages
        )
        _, output = ans
        return self._clean_conda_json(output)

    async def remove_packages(self, env: str, packages: List[str]) -> Dict[str, str]:
        """Delete packages in an environment.

        Args:
            env (str): Environment name
            packages (List[str]): List of packages to delete

        Returns:
            Dict[str, str]: Delete command output.
        """
        ans = await self._execute(
            self.manager, "remove", "-y", "-q", "--json", "-n", env, *packages
        )
        _, output = ans
        return self._clean_conda_json(output)

    async def get_subdir(self):
        rcode, output = await self._execute(
            self.manager, "list", "--explicit"
        )
        if rcode == 0:
            regex = re.compile('^# platform: ([a-z\-0-9]+)$', re.MULTILINE)
            return {'subdir': regex.findall(output)[0]}

        raise RuntimeError('subdir not found')
