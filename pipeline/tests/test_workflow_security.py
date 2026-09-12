"""Guard the CI trust boundary against accidental credential scope regressions."""
from pathlib import Path
import re
import unittest
import yaml


class WorkflowSecurityTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.load(
            (Path(__file__).resolve().parents[2] / ".github/workflows/publish-latest-preview.yml").read_text(),
            Loader=yaml.BaseLoader,
        )

    def test_secrets_exist_only_on_the_publishing_step(self):
        workflow = self.workflow
        self.assertNotIn("secrets.", str(workflow.get("env", {})))
        exposures = []
        for name, job in workflow["jobs"].items():
            self.assertNotIn("secrets.", str(job.get("env", {})))
            for step in job["steps"]:
                if "secrets." in str(step):
                    exposures.append((name, step["name"]))
                    self.assertEqual(set(k for k, v in step["env"].items() if "secrets." in v),
                                     {"R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"})
                    self.assertNotIn("pip install", step["run"])
                    self.assertIn("python -m nevaio_pipeline.publish", step["run"])
        self.assertEqual(exposures, [("publish", "Publish validated run")])

    def test_fresh_hosted_jobs_protected_ref_and_environment(self):
        jobs = self.workflow["jobs"]
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        self.assertEqual(set(self.workflow["on"]), {"schedule", "workflow_dispatch"})
        self.assertEqual(jobs["publish"]["needs"], "render")
        self.assertEqual(jobs["publish"]["environment"], "production-r2")
        self.assertNotIn("environment", jobs["render"])
        for job in jobs.values():
            self.assertEqual(job["runs-on"], "ubuntu-24.04")
            self.assertEqual(job["if"], "github.ref == 'refs/heads/main'")

    def test_actions_are_pinned_and_checkout_does_not_persist_credentials(self):
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                if "uses" in step:
                    self.assertRegex(step["uses"], r"^actions/[a-z-]+@[0-9a-f]{40}$")
                    if step["uses"].startswith("actions/checkout@"):
                        self.assertEqual(step["with"]["persist-credentials"], "false")
                self.assertNotIn("cache", step.get("with", {}))
                if "pip install" in step.get("run", ""):
                    self.assertIn("--require-hashes", step["run"])
                    self.assertIn("--only-binary=:all:", step["run"])

    def test_artifact_is_data_outside_checkout_not_a_script_or_dependency_source(self):
        render = self.workflow["jobs"]["render"]["steps"]
        publish = self.workflow["jobs"]["publish"]["steps"]
        upload = next(s for s in render if s.get("uses", "").startswith("actions/upload-artifact@"))
        download = next(s for s in publish if s.get("uses", "").startswith("actions/download-artifact@"))
        self.assertEqual(upload["with"]["name"], download["with"]["name"])
        self.assertIn("github.run_attempt", download["with"]["name"])
        self.assertEqual(download["with"]["path"], "${{ runner.temp }}/rendered-runs")
        self.assertNotIn("github-token", download["with"])
        self.assertNotIn("run-id", download["with"])
        self.assertNotIn("--publish-r2", str(render))
        installs = [s["run"] for s in publish if "pip install" in s.get("run", "")]
        self.assertEqual(len(installs), 1)
        self.assertIn("pipeline/requirements-publish.txt", installs[0])
        for step in publish:
            self.assertNotIn("working-directory", step)
            self.assertNotRegex(step.get("run", ""), r"(?:cd|source|bash|python)\s+[^\n]*rendered-runs")

    def test_publication_is_verified_against_public_objects_without_secrets(self):
        publish = self.workflow["jobs"]["publish"]["steps"]
        verify = next(s for s in publish if s["name"].startswith("Verify public pointer"))
        # Both public contracts are checked, and the catalogue through the
        # same validator the frontend's contract is written against.
        self.assertIn("/latest.json", verify["run"])
        self.assertIn("/dates.json", verify["run"])
        self.assertIn("validate_date_catalogue", verify["run"])
        # Reading public URLs needs no credentials, and must not acquire any.
        self.assertNotIn("secrets.", str(verify))
        self.assertEqual(set(verify["env"]), {"R2_PUBLIC_BASE_URL"})

    def test_publisher_lock_excludes_render_stack_and_every_entry_has_hashes(self):
        root = Path(__file__).resolve().parents[1]
        for name in ("requirements.txt", "requirements-publish.txt"):
            lock = (root / name).read_text()
            entries = re.split(r"(?m)^(?=[A-Za-z0-9][A-Za-z0-9_-]*==)", lock)[1:]
            self.assertTrue(entries)
            for entry in entries:
                self.assertRegex(entry, r"^[A-Za-z0-9_-]+==[^\s]+ \\\n")
                self.assertRegex(entry, r"--hash=sha256:[0-9a-f]{64}")
        packages = set(re.findall(r"(?m)^([A-Za-z0-9_-]+)==", (root / "requirements-publish.txt").read_text()))
        self.assertEqual(packages, {"boto3", "botocore", "jmespath", "python-dateutil", "s3transfer", "six", "urllib3"})


class ObjectIndexWorkflowSecurityTests(unittest.TestCase):
    """The same trust boundary, over the OSM object index publisher.

    A second workflow reaching the same `production-r2` environment is a
    second way to leak the publication key, so it is held to the invariants
    above rather than trusted for being small. Only the assertions that
    generalise live here; the daily workflow's own shape stays in
    `WorkflowSecurityTests`.
    """

    def setUp(self):
        self.workflow = yaml.load(
            (Path(__file__).resolve().parents[2] / ".github/workflows/publish-osm-object-index.yml").read_text(),
            Loader=yaml.BaseLoader,
        )

    def test_secrets_exist_only_on_the_publishing_step(self):
        workflow = self.workflow
        self.assertNotIn("secrets.", str(workflow.get("env", {})))
        exposures = []
        for name, job in workflow["jobs"].items():
            self.assertNotIn("secrets.", str(job.get("env", {})))
            for step in job["steps"]:
                if "secrets." in str(step):
                    exposures.append((name, step["name"]))
                    self.assertEqual(set(k for k, v in step["env"].items() if "secrets." in v),
                                     {"R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"})
                    self.assertNotIn("pip install", step["run"])
                    self.assertIn("python -m nevaio_pipeline.publish_object_index", step["run"])
        self.assertEqual(exposures, [("publish", "Publish validated object index")])

    def test_fresh_hosted_jobs_protected_ref_and_environment(self):
        jobs = self.workflow["jobs"]
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        # Manual only: the index changes when the OSM extracts refresh, which
        # is not a schedule. A cron here would republish identical bytes daily.
        self.assertEqual(set(self.workflow["on"]), {"workflow_dispatch"})
        self.assertEqual(jobs["publish"]["needs"], "build")
        self.assertEqual(jobs["publish"]["environment"], "production-r2")
        self.assertNotIn("environment", jobs["build"])
        for job in jobs.values():
            self.assertEqual(job["runs-on"], "ubuntu-24.04")
            self.assertEqual(job["if"], "github.ref == 'refs/heads/main'")

    def test_actions_are_pinned_and_checkout_does_not_persist_credentials(self):
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                if "uses" in step:
                    self.assertRegex(step["uses"], r"^actions/[a-z-]+@[0-9a-f]{40}$")
                    if step["uses"].startswith("actions/checkout@"):
                        self.assertEqual(step["with"]["persist-credentials"], "false")
                self.assertNotIn("cache", step.get("with", {}))
                if "pip install" in step.get("run", ""):
                    self.assertIn("--require-hashes", step["run"])
                    self.assertIn("--only-binary=:all:", step["run"])

    def test_artifact_is_data_outside_checkout_not_a_script_or_dependency_source(self):
        build = self.workflow["jobs"]["build"]["steps"]
        publish = self.workflow["jobs"]["publish"]["steps"]
        upload = next(s for s in build if s.get("uses", "").startswith("actions/upload-artifact@"))
        download = next(s for s in publish if s.get("uses", "").startswith("actions/download-artifact@"))
        self.assertEqual(upload["with"]["name"], download["with"]["name"])
        self.assertIn("github.run_attempt", download["with"]["name"])
        self.assertEqual(download["with"]["path"], "${{ runner.temp }}/object-index")
        self.assertNotIn("github-token", download["with"])
        self.assertNotIn("run-id", download["with"])
        installs = [s["run"] for s in publish if "pip install" in s.get("run", "")]
        self.assertEqual(len(installs), 1)
        self.assertIn("pipeline/requirements-publish.txt", installs[0])
        for step in publish:
            self.assertNotIn("working-directory", step)
            self.assertNotRegex(step.get("run", ""), r"(?:cd|source|bash|python)\s+[^\n]*/object-index\b")

    def test_the_untrusted_artifact_is_revalidated_before_any_secret_is_in_scope(self):
        publish = self.workflow["jobs"]["publish"]["steps"]
        names = [s["name"] for s in publish]
        check = next(s for s in publish if "--check-only" in s.get("run", ""))
        self.assertNotIn("secrets.", str(check))
        self.assertLess(names.index(check["name"]),
                        names.index("Publish validated object index"))

    def test_publication_is_verified_against_public_objects_without_secrets(self):
        publish = self.workflow["jobs"]["publish"]["steps"]
        verify = next(s for s in publish if s["name"].startswith("Verify published index"))
        self.assertIn("/object-index/object-index.json", verify["run"])
        self.assertNotIn("secrets.", str(verify))
        self.assertEqual(set(verify["env"]), {"R2_PUBLIC_BASE_URL"})

    def test_the_untrusted_extract_urls_input_never_reaches_a_shell_unquoted(self):
        """The one attacker-controlled input in this workflow.

        `workflow_dispatch` inputs are typed by whoever clicks Run, so the URL
        list must arrive as an environment variable and stay quoted - a bare
        `${{ inputs.* }}` inside `run:` is shell injection on a job that can
        hand an artifact to the credentialed job.
        """
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                self.assertNotIn("inputs.", step.get("run", ""))
        download = next(s for s in self.workflow["jobs"]["build"]["steps"]
                        if s["name"] == "Download OSM extracts")
        self.assertEqual(download["env"], {"OSM_EXTRACT_URLS": "${{ inputs.osm_extract_urls }}"})
        self.assertIn('"${OSM_EXTRACT_URLS}"', download["run"])


if __name__ == "__main__":
    unittest.main()
