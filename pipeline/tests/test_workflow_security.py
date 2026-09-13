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


class DailySnowDataPyramidTests(unittest.TestCase):
    """The daily run must keep rendering the snow *data* pyramid.

    Not a security property - a correctness one with no alarm attached. If
    ``--data-tiles`` is ever dropped from the render step, nothing fails: the
    run publishes, the map looks right, and the route profile quietly says
    "Snow along the route is not available for this date" forever, because
    that is also the honest answer for a date genuinely rendered without it.
    A silent feature outage with a plausible-looking message is exactly the
    kind of regression no other test in this repo would catch, so it is
    asserted here against the workflow file itself.
    """

    def setUp(self):
        self.workflow = yaml.load(
            (Path(__file__).resolve().parents[2] / ".github/workflows/publish-latest-preview.yml").read_text(),
            Loader=yaml.BaseLoader,
        )

    def test_the_daily_render_publishes_data_tiles(self):
        render = next(s for s in self.workflow["jobs"]["render"]["steps"]
                      if s["name"] == "Render snapshot")
        self.assertIn("--data-tiles", render["run"])

    def test_data_tiles_are_not_gated_behind_a_dispatch_input(self):
        """Every scheduled run is a "latest date" run, so the flag is unconditional.

        The owner's decision (2026-09-13) was latest-date-only, which this
        workflow satisfies by construction: it always renders the current
        date, and the historical dates already published are simply not
        backfilled. Making the flag conditional on an input would instead mean
        the *scheduled* run could silently render without it - the one run
        that must always have it.
        """
        render = next(s for s in self.workflow["jobs"]["render"]["steps"]
                      if s["name"] == "Render snapshot")
        # Comment lines mention the flag by name, so compare against code only.
        script = "\n".join(l for l in render["run"].splitlines() if not l.lstrip().startswith("#"))
        self.assertEqual(script.count("--data-tiles"), 1)
        # It must sit in the initial `args=( ... )` literal, which runs on
        # every invocation - not in one of the `if [[ -n "${...}" ]]` blocks
        # below it, each of which appends only when its dispatch input was
        # given and so would leave the scheduled run without the flag.
        opening = script.index("args=(")
        closing = script.index("\n)", opening)
        self.assertLess(script.index("--data-tiles"), closing)
        self.assertGreater(script.index("--data-tiles"), opening)


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


class BackfillObjectSeriesWorkflowSecurityTests(unittest.TestCase):
    """The same trust boundary, over the historical per-object series backfill.

    A third workflow reaching `production-r2` is a third way to leak the
    publication key (docs/agent-guide.md: "Add a third workflow and it gets a
    class in that file too"). Only the assertions that generalise across the
    three workflows live here; this workflow's own matrix/resume shape is
    checked in the tests that follow.
    """

    def setUp(self):
        self.workflow = yaml.load(
            (Path(__file__).resolve().parents[2] / ".github/workflows/backfill-object-series.yml").read_text(),
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
                    self.assertIn("python -m nevaio_pipeline.publish_object_series", step["run"])
        self.assertEqual(exposures, [("publish", "Publish validated series")])

    def test_fresh_hosted_jobs_protected_ref_and_environment(self):
        jobs = self.workflow["jobs"]
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        # Manual only, like the object index workflow: a backfill is an
        # occasional, owner-initiated action - a schedule would redo the same
        # months forever.
        self.assertEqual(set(self.workflow["on"]), {"workflow_dispatch"})
        self.assertEqual(jobs["render"]["needs"], "prepare")
        self.assertEqual(jobs["publish"]["needs"], ["prepare", "render"])
        self.assertEqual(jobs["publish"]["environment"], "production-r2")
        self.assertNotIn("environment", jobs["prepare"])
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
        # Both names carry the matrix month as well as the run id/attempt, so
        # a render job's artifact is only ever consumed by the publish job of
        # the *same* month within the *same* run.
        self.assertEqual(upload["with"]["name"], download["with"]["name"])
        self.assertIn("matrix.month", upload["with"]["name"])
        self.assertIn("github.run_attempt", upload["with"]["name"])
        self.assertNotIn("github-token", download["with"])
        self.assertNotIn("run-id", download["with"])
        installs = [s["run"] for s in publish if "pip install" in s.get("run", "")]
        self.assertEqual(len(installs), 1)
        self.assertIn("pipeline/requirements-publish.txt", installs[0])
        for step in publish:
            self.assertNotIn("working-directory", step)

    def test_the_untrusted_artifact_is_revalidated_before_any_secret_is_in_scope(self):
        publish = self.workflow["jobs"]["publish"]["steps"]
        names = [s["name"] for s in publish]
        check = next(s for s in publish if "--check-only" in s.get("run", ""))
        self.assertNotIn("secrets.", str(check))
        self.assertLess(names.index(check["name"]), names.index("Publish validated series"))

    def test_publication_is_verified_against_public_objects_without_secrets(self):
        publish = self.workflow["jobs"]["publish"]["steps"]
        verify = next(s for s in publish if s["name"].startswith("Verify per-tile series"))
        self.assertNotIn("secrets.", str(verify))
        self.assertEqual(set(verify["env"]), {"R2_PUBLIC_BASE_URL", "MONTH"})

    def test_the_untrusted_dispatch_inputs_never_reach_a_shell_unquoted(self):
        """Two attacker-controlled inputs here: `months` and `tiles`.

        Both must arrive as environment variables and stay quoted, the same
        rule publish-osm-object-index.yml applies to `osm_extract_urls` - a
        bare `${{ inputs.* }}` inside `run:` is shell injection on a job that
        hands an artifact to a credentialed job.
        """
        for job in self.workflow["jobs"].values():
            for step in job["steps"]:
                self.assertNotIn("inputs.", step.get("run", ""))
        parse = next(s for s in self.workflow["jobs"]["prepare"]["steps"]
                     if s["name"] == "Parse and validate the months input")
        self.assertEqual(parse["env"], {"MONTHS": "${{ inputs.months }}"})
        self.assertIn('os.environ["MONTHS"]', parse["run"])

        resolve = next(s for s in self.workflow["jobs"]["render"]["steps"]
                       if s["name"].startswith("Resolve tiles to attempt"))
        self.assertEqual(resolve["env"]["REQUESTED_TILES"], "${{ inputs.tiles }}")
        self.assertIn('"${REQUESTED_TILES}"', resolve["run"])

    def test_matrix_is_built_from_the_validated_prepare_output_not_the_raw_input(self):
        jobs = self.workflow["jobs"]
        for name in ("render", "publish"):
            matrix = jobs[name]["strategy"]["matrix"]["month"]
            self.assertEqual(matrix, "${{ fromJson(needs.prepare.outputs.months) }}")

    def test_backfill_never_writes_a_slot_map(self):
        """The one invariant that matters most (docs/agent-guide.md).

        This workflow's publish step must point --slots-dir at a directory
        that is never populated by the render job, so it can only ever
        publish zero slot maps - the render side
        (backfill_object_series.py) has no code path that writes one at all.
        """
        publish = self.workflow["jobs"]["publish"]["steps"]
        for step in publish:
            run = step.get("run", "")
            if "publish_object_series" in run:
                self.assertIn("--slots-dir", run)
                self.assertNotIn("index-fetch/slots", run)
        render = self.workflow["jobs"]["render"]["steps"]
        for step in render:
            self.assertNotIn("write_slot_map", step.get("run", ""))

    def test_a_confirmed_404_slot_map_fails_the_job_rather_than_first_run(self):
        """Backfill's one deliberate divergence from the daily workflow's fetch step.

        The daily workflow treats a 404 as "first run for this tile" and lets
        load_or_create_slot_map build a fresh map. Backfill must not: every
        tile with a published shard already has a published slot map, so a
        confirmed-absent one here means something is wrong, not "first run".
        """
        render = self.workflow["jobs"]["render"]["steps"]
        resolve = next(s for s in render if s["name"].startswith("Resolve tiles to attempt"))
        self.assertIn("404)", resolve["run"])
        self.assertIn("exit 1", resolve["run"])
        self.assertNotIn("load_or_create_slot_map", resolve["run"])

    def test_an_existing_month_file_is_fetched_for_merge_not_used_to_skip_the_tile(self):
        """The bug the coordinator caught: skip-if-published made backfill a no-op.

        This step must GET the existing series/<TILE>/<MONTH>.bin into the
        same directory the sampler reads and writes, not merely HEAD it to
        decide whether to bother - the daily job's own 31-day AS-OF window
        means a month file it already touched is routinely still partial, and
        that partial file is exactly what a backfill exists to complete.
        """
        render = self.workflow["jobs"]["render"]["steps"]
        resolve = next(s for s in render if s["name"].startswith("Resolve tiles to attempt"))
        run = resolve["run"]
        self.assertIn("series_base", run)
        self.assertIn('--output "${series_dir}/${tile}/${MONTH}.bin"', run)
        # The old skip-on-200 shortcut must be gone: every tile that reaches
        # this point is still handed to the sampler, which decides on its own
        # (cheaply) whether anything is left to do.
        self.assertNotIn("skipping (resume)", run)
        sample = next(s for s in render if s["name"] == "Sample this month's series")
        self.assertNotIn("already published", sample["run"])

    def test_the_publish_job_never_assumes_an_unpublished_month_and_cannot_truncate(self):
        """Guards against reintroducing the rejected "just overwrite" design.

        publish_object_series.py's put_object always replaces the key
        wholesale, so the only thing preventing truncation is that the bytes
        handed to it were already merged (never shrunk) by
        backfill_object_series.py before this job ever sees them - this job
        itself has no size or emptiness check of its own, which is fine only
        because the render job's own merge is the safeguard. This test at
        least pins that the publish job still does not read or derive a slot
        count from anywhere - it only moves bytes the render job already
        finished merging.
        """
        publish = self.workflow["jobs"]["publish"]["steps"]
        for step in publish:
            self.assertNotIn("grow_month_array", step.get("run", ""))
            self.assertNotIn("new_month_array", step.get("run", ""))


if __name__ == "__main__":
    unittest.main()
