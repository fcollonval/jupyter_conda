"""
# Copyright (c) 2015-2016 Continuum Analytics.
# Copyright (c) 2016-2020 Jupyter Development Team.
# See LICENSE.txt for the license.
"""
# pylint: disable=W0221

import asyncio
import collections
import json
import logging
import os
import re
import stat
import sys
import tempfile
import traceback
from typing import Any, Callable, ClassVar, Dict, NoReturn

import tornado

from .envmanager import EnvManager
from .log import get_logger
from jupyter_server.base.handlers import APIHandler
from jupyter_server.utils import url_path_join

NS = r"conda"
# Filename for the available conda packages list cache in temp folder
AVAILABLE_CACHE = "mamba_gator_packages"


class ActionsStack:
    """Process long asynchronous task.

    The task result can only be queried once.

    Note: The task start immediately => may bring trouble if the user is not careful,
    this assumes 'conda' handle lockers when appropriate.
    """

    __last_index: ClassVar[int] = 0

    def __init__(self):
        self.__tasks: Dict[int, asyncio.Task] = dict()

    def cancel(self, idx: int) -> NoReturn:
        """Cancel the task `idx`.

        Args:
            idx (int): Task index
        """
        get_logger().debug("Cancel task {}.".format(idx))
        if idx not in self.__tasks:
            raise ValueError("Task {} does not exists.".format(idx))

        self.__tasks[idx].cancel()

    def get(self, idx: int) -> Any:
        """Get the task `idx` results or None.

        Args:
            idx (int): Task index

        Returns:
            Any: None if the task is pending else its result

        Raises:
            ValueError: If the task `idx` does not exists.
            asyncio.CancelledError: If the task `idx` was cancelled.
        """
        if idx not in self.__tasks:
            raise ValueError("Task {} does not exists.".format(idx))

        if self.__tasks[idx].done():
            task = self.__tasks.pop(idx)
            return task.result()
        else:
            return None

    def put(self, task: Callable, *args) -> int:
        """Add a asynchronous task into the queue.

        Args:
            task (Callable): Asynchronous task
            *args : arguments of the task

        Returns:
            int: Task id
        """
        ActionsStack.__last_index += 1
        idx = ActionsStack.__last_index

        async def execute_task(idx, f, *args) -> Any:
            try:
                get_logger().debug("Will execute task {}.".format(idx))
                result = await f(*args)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                exception_type, _, tb = sys.exc_info()
                result = {
                    "type": exception_type.__qualname__,
                    "error": str(e),
                    "message": repr(e),
                    "traceback": traceback.format_tb(tb),
                }
                get_logger().error("Error for task {}.".format(result))
            else:
                get_logger().debug("Has executed task {}.".format(idx))

            return result

        self.__tasks[idx] = asyncio.ensure_future(execute_task(idx, task, *args))
        return idx

    def __del__(self):
        for task in filter(lambda t: not t.cancelled(), self.__tasks.values()):
            task.cancel()


class EnvBaseHandler(APIHandler):
    """
    Mixin for an env manager. Just maintains a reference to the
    'env_manager' which implements all of the conda functions.
    """

    _stack: ClassVar[ActionsStack] = ActionsStack()

    @property
    def env_manager(self) -> EnvManager:
        """EnvManager : Return our env_manager instance"""
        return self.settings["env_manager"]

    @property
    def log(self) -> logging.Logger:
        """logging.Logger: The extension logger"""
        return get_logger()

    def redirect_to_task(self, index: int):
        """Close a request by redirecting to a task."""
        self.set_status(202)
        self.set_header("Location", "/{}/tasks/{}".format(NS, index))
        self.finish("{}")


class ChannelsHandler(EnvBaseHandler):
    """Handle channels actions."""

    @tornado.web.authenticated
    async def get(self):
        """`GET /channels` list the channels."""
        channels = await self.env_manager.env_channels()
        if "error" in channels:
            self.set_status(500)
        self.finish(tornado.escape.json_encode(channels))


class EnvironmentsHandler(EnvBaseHandler):
    """Environments handler."""

    @tornado.web.authenticated
    async def get(self):
        """`GET /environments` which lists the environments.

        Query arguments:
            whitelist (int): optional flag 0 or 1 to respect KernelSpecManager.whitelist

        Raises:
            500 if an error occurs
        """
        whitelist = int(self.get_query_argument("whitelist", 0))
        list_envs = await self.env_manager.list_envs(whitelist == 1)
        if "error" in list_envs:
            self.set_status(500)
        self.finish(tornado.escape.json_encode(list_envs))

    @tornado.web.authenticated
    def post(self):
        """`POST /environments` creates an environment.

        Method of creation depends on the request data (first find is used):

        * packages: Create from a list of packages
        * twin: Clone the environment given by its name
        * file: Import from the given file content

        Request json body:
        {
            name (str): environment name
            packages (List[str]): optional, list of packages to install
            twin (str): optional, environment name to clone
            file (str): optional, environment file (TXT or YAML format)
            filename (str): optional, environment filename of the `file` content
        }
        """
        data = self.get_json_body()
        name = data["name"]
        packages = data.get("packages", None)
        twin = data.get("twin", None)
        file_content = data.get("file", None)
        file_name = data.get("filename", "environment.txt")

        if packages is not None:
            idx = self._stack.put(self.env_manager.create_env, name, *packages)
        elif twin is not None:
            idx = self._stack.put(self.env_manager.clone_env, twin, name)
        elif file_content is not None:
            idx = self._stack.put(
                self.env_manager.import_env, name, file_content, file_name
            )
        else:
            idx = self._stack.put(self.env_manager.create_env, name)

        self.redirect_to_task(idx)


class EnvironmentHandler(EnvBaseHandler):
    """Environment handler."""

    @tornado.web.authenticated
    def delete(self, env: str):
        """`DELETE /environments/<env>` deletes an environment."""
        idx = self._stack.put(self.env_manager.delete_env, env)

        self.redirect_to_task(idx)

    @tornado.web.authenticated
    async def get(self, env: str):
        """`GET /environments/<env>` List or export the environment packages.

        Query arguments:
            status: "installed" (default) or "has_update"
            download: 0 (default) or 1
            history: 0 (default) or 1
        """
        status = self.get_query_argument("status", "installed")
        download = int(self.get_query_argument("download", 0))
        history = int(self.get_query_argument("history", 0))

        if download:
            # export requirements file
            self.set_header(
                "Content-Disposition", 'attachment; filename="%s"' % (env + ".yml")
            )
            answer = await self.env_manager.export_env(env, bool(history))
            if "error" in answer:
                self.set_status(500)
                self.finish(tornado.escape.json_encode(answer))
            else:
                self.finish(answer)

        else:
            if status == "has_update":
                idx = self._stack.put(self.env_manager.check_update, env, ["--all"])

                self.redirect_to_task(idx)

            else:
                packages = await self.env_manager.env_packages(env)

                if "error" in packages:
                    self.set_status(500)
                self.finish(tornado.escape.json_encode(packages))

    @tornado.web.authenticated
    def patch(self, env: str):
        """`PATCH /environments/<env>` update an environment.

        Request json body:
        {
            file (str): optional, environment file (TXT or YAML format)
            filename (str): optional, environment filename of the `file` content
        }
        """
        data = self.get_json_body()
        file_content = data["file"]
        file_name = data.get("filename", "environment.yml")

        idx = self._stack.put(self.env_manager.update_env, env, file_content, file_name)

        self.redirect_to_task(idx)


class PackagesEnvironmentHandler(EnvBaseHandler):
    """Handle actions on environment packages."""

    @tornado.web.authenticated
    def delete(self, env: str):
        """`DELETE /environments/<env>/packages` delete some packages.

        Request json body:
        {
            packages (List[str]): list of packages to delete
        }
        """
        body = self.get_json_body()
        packages = body["packages"]
        idx = self._stack.put(self.env_manager.remove_packages, env, packages)
        self.redirect_to_task(idx)

    @tornado.web.authenticated
    def patch(self, env: str):
        """`PATCH /environments/<env>/packages` update some packages.

        If no packages are provided, update all possible packages.

        Request json body:
        {
            packages (List[str]): optional, list of packages to update
        }
        """
        body = self.get_json_body() or {}
        packages = body.get("packages", ["--all"])
        idx = self._stack.put(self.env_manager.update_packages, env, packages)
        self.redirect_to_task(idx)

    @tornado.web.authenticated
    def post(self, env: str):
        """`POST /environments/<env>/packages` install some packages.

        Packages can be installed in development mode. In that case,
        the fullpath to the package directory should be provided.

        Query arguments:
            develop: 0 (default) or 1

        Request json body:
        {
            packages (List[str]): list of packages to install
        }
        """
        body = self.get_json_body()
        packages = body["packages"]
        develop = int(self.get_query_argument("develop", 0))

        if develop:
            idx = self._stack.put(self.env_manager.develop_packages, env, packages)
        else:
            idx = self._stack.put(self.env_manager.install_packages, env, packages)
        self.redirect_to_task(idx)


class PackagesHandler(EnvBaseHandler):
    """Handles packages search"""

    __is_listing_available = False

    @tornado.web.authenticated
    async def get(self):
        """`GET /packages` Search for packages.

        Query arguments:
            dependencies: 0 (default) or 1
            query (str): optional string query
        """
        dependencies = self.get_query_argument("dependencies", 0)
        query = self.get_query_argument("query", "")

        idx = None
        if query:
            if dependencies:
                idx = self._stack.put(self.env_manager.pkg_depends, query)

            else:  # Specific search
                idx = self._stack.put(self.env_manager.package_search, query)

        else:  # List all available
            cache_file = os.path.join(tempfile.gettempdir(), AVAILABLE_CACHE + ".json")
            cache_data = ""
            try:
                with open(cache_file) as cache:
                    cache_data = cache.read()
            except OSError as e:
                self.log.info("No available packages list in cache.")
                self.log.debug(str(e))

            async def update_available(
                env_manager: EnvManager, cache_file: str, return_packages: bool = True
            ) -> Dict:
                answer = await env_manager.list_available()
                try:
                    with open(cache_file, "w+") as cache:
                        json.dump(answer, cache)
                except (ValueError, OSError) as e:
                    self.log.info("Fail to cache available packages.")
                    self.log.debug(str(e))
                else:
                    # Change rights to ensure every body can update the cache
                    os.chmod(
                        cache_file,
                        stat.S_IMODE(os.stat(cache_file).st_mode)
                        | (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH),
                    )
                PackagesHandler.__is_listing_available = False

                if return_packages:
                    return answer
                else:
                    return {}

            if len(cache_data) > 0:
                self.log.debug("Loading available packages from cache.")
                # Request cache update in background
                if not PackagesHandler.__is_listing_available:
                    PackagesHandler.__is_listing_available = True
                    self._stack.put(
                        update_available, self.env_manager, cache_file, False
                    )
                # Return current cache
                self.set_status(200)
                self.finish(cache_data)
            else:
                # Request cache update and return once updated
                PackagesHandler.__is_listing_available = True
                idx = self._stack.put(update_available, self.env_manager, cache_file)

        if idx is not None:
            self.redirect_to_task(idx)


class TaskHandler(EnvBaseHandler):
    """Handler for /tasks/<id>"""

    @tornado.web.authenticated
    def get(self, index: int):
        """`GET /tasks/<id>` Returns the task `index` status.

        Status are:

        * 200: Task result is returned
        * 202: Task is pending
        * 500: Task ends with errors

        Args:
            index (int): Task index

        Raises:
            404 if task `index` does not exist
        """
        try:
            r = self._stack.get(int(index))
        except ValueError as err:
            raise tornado.web.HTTPError(404, reason=str(err))
        else:
            if r is None:
                self.set_status(202)
                self.finish("{}")
            else:
                if "error" in r:
                    self.set_status(500)
                    self.log.debug("{}".format(r))
                else:
                    self.set_status(200)
                self.finish(json.dumps(r))

    @tornado.web.authenticated
    def delete(self, index: int):
        """`DELETE /tasks/<id>` cancels the task `index`.

        Status are:
        * 204: Task cancelled

        Args:
            index (int): Task index

        Raises:
            404 if task `index` does not exist
        """
        try:
            self._stack.cancel(int(index))
        except ValueError as err:
            raise tornado.web.HTTPError(404, reason=str(err))
        else:
            self.set_status(204)
            self.finish()


class SubdirHandler(EnvBaseHandler):
    @tornado.web.authenticated
    async def get(self):
        """`GET /subdir` Get the conda-subdir.
        """
        idx = self._stack.put(self.env_manager.get_subdir)

        self.redirect_to_task(idx)

# -----------------------------------------------------------------------------
# URL to handler mappings
# -----------------------------------------------------------------------------

# there is almost no text that is invalid, but no hyphens up front, please
# neither all these suspicious but valid caracthers...
_env_regex = r"(?P<env>[^/&+$?@<>%*-][^/&+$?@<>%*]*)"  # type: str


default_handlers = [
    (r"/channels", ChannelsHandler),
    (r"/environments", EnvironmentsHandler),  # GET / POST
    (r"/environments/%s" % _env_regex, EnvironmentHandler),  # GET / PATCH / DELETE
    (r"/subdir", SubdirHandler),  # GET
    # PATCH / POST / DELETE
    (r"/environments/%s/packages" % _env_regex, PackagesEnvironmentHandler),
    (r"/packages", PackagesHandler),  # GET
    (r"/tasks/%s" % r"(?P<index>\d+)", TaskHandler),  # GET / DELETE
]


def _load_jupyter_server_extension(server_app):
    """Load the nbserver extension"""
    webapp = server_app.web_app
    webapp.settings["env_manager"] = EnvManager(
        server_app.contents_manager.root_dir, server_app.kernel_spec_manager
    )

    base_url = webapp.settings["base_url"]
    webapp.add_handlers(
        ".*$",
        [
            (url_path_join(base_url, NS, pat), handler)
            for pat, handler in default_handlers
        ],
    )

    get_logger().info("Server extension enabled")
