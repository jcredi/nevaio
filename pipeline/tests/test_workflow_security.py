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
                    self.assertIn("python -m pipeline.publish", step["run"])
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


if __name__ == "__main__":
    unittest.main()
