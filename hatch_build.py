"""Build the public provisioning template archive from explicit source inputs."""

import importlib.util
from pathlib import Path
import tempfile

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if self.target_name != "wheel":
            return
        root = Path(self.root)
        spec = importlib.util.spec_from_file_location(
            "sourcesql_packaged_resources", root / "src/sourcesql/resources.py"
        )
        resources = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(resources)
        self.temporary = tempfile.TemporaryDirectory(prefix="sourcesql-package-")
        output = Path(self.temporary.name) / "personal-cloud.zip"
        output.write_bytes(resources.build_personal_cloud_archive(root))
        build_data["force_include"][str(output)] = "sourcesql/" + resources.ARCHIVE

    def finalize(self, version, build_data, artifact_path):
        if hasattr(self, "temporary"):
            self.temporary.cleanup()
