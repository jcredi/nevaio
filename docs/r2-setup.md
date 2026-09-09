# Cloudflare R2 setup for the GFSC snapshot

The publish workflow renders one "latest conditions" tile set for the whole MVP
area, composing each MGRS tile's 15-day GFSC window under the spec section 9.2
AS-OF rule. It uploads an immutable run first and replaces `latest.json` only
after every tile is present, so the app never sees a partial publication. It
keeps the newest seven runs and prunes older ones after the pointer has moved;
it does not build a historical archive.

## One-time Cloudflare setup

1. In **Cloudflare > R2 object storage**, create a Standard-storage bucket. A
   name such as `spikely-snow` is sufficient.
2. In the R2 overview, choose **Manage R2 API tokens** and create an account API
   token with **Object Read & Write** permission, scoped to this bucket only.
   Copy the Access Key ID and Secret Access Key immediately; Cloudflare does not
   show the secret again.
3. For the first preview, open the bucket's **Settings** and enable its Public
   Development URL. Copy the complete `https://…r2.dev` URL. This endpoint is
   rate-limited and is for testing only.
4. Before public launch, connect a custom domain from the same Cloudflare
   account under **Settings > Custom Domains** and use its `https://` origin in
   GitHub instead. A custom domain enables Cloudflare caching; the development
   URL does not. Disable the development URL once the migration is complete, so
   it cannot be used to bypass the custom domain's controls.

   **`app/public/_headers` names the current bucket host in its
   Content-Security-Policy**, so change that file in the same commit or the
   browser will block every snow tile. Afterwards verify with
   `NEVAIO_URL=https://nevaio.netlify.app npm run check-csp` from `app/` - it
   fails on exactly this mistake. See `docs/security.md`.
5. Add this CORS policy under **Settings > CORS Policy**. Include the production
   Netlify origin and local Vite origins used for testing:

   ```json
   [
     {
       "AllowedOrigins": [
         "https://nevaio.netlify.app",
         "http://localhost:5173",
         "http://127.0.0.1:5173"
       ],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   Cloudflare documents an existing object as a CORS-policy prerequisite. If
   the new empty bucket does not expose the CORS editor yet, run the workflow
   once, then add this policy before opening the preview in the app.

If the custom domain already served cached objects before CORS was configured,
purge that hostname's cache once after saving the policy.

Cloudflare references: [S3 credentials](https://developers.cloudflare.com/r2/get-started/s3/),
[public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/),
and [CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## GitHub Actions configuration

**Security migration:** follow [publication security setup](publishing-security.md)
before activating the separated workflow. Production credentials now belong
to the `production-r2` environment restricted to `main`, not repository secrets.


Open **GitHub repository > Settings > Environments > production-r2**
for secrets. Repository variables remain under **Secrets and variables > Actions**.

Add two secrets in the **production-r2 environment**:

| Secret | Value |
| --- | --- |
| `R2_ACCESS_KEY_ID` | Access Key ID shown when the scoped R2 token was created |
| `R2_SECRET_ACCESS_KEY` | Secret Access Key shown once when the token was created |

Add three repository variables (they are configuration, not credentials):

| Variable | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Cloudflare account ID containing the bucket |
| `R2_BUCKET` | Bucket name, for example `spikely-snow` (the app was renamed to Nevaio on 2026-09-07, but R2 has no in-place bucket rename - the existing bucket is still literally called `spikely-snow`, and renaming it would mean creating a new bucket and migrating every object, for a name nobody outside this repo ever sees. Not worth doing unless the bucket itself is rebuilt for another reason) |
| `R2_PUBLIC_BASE_URL` | Public origin without a trailing slash, initially `https://…r2.dev` and later the custom domain |

The workflow has read-only repository permission. Its R2 token can write only
to the selected bucket; do not use a Cloudflare-wide administrative token.

## Run and verify the snapshot

The workflow runs itself daily at `04:35 UTC`. To run it by hand, use
**GitHub > Actions > Publish latest GFSC snapshot > Run workflow** and leave the
inputs blank for today's snapshot across the full Alps and Apennines MVP area.
`as_of_date` reproduces an earlier catalogue cutoff (the AS-OF window moves with
it). `tiles` accepts a space-separated subset such as `32TNS 32TNT 33TUN` for a
cheaper smoke test. `max_missing_tiles` raises the tolerance for tiles with no
product in the window - the default of `0` fails the run instead of publishing a
partial map, which leaves the previously published `latest.json` serving.

Equivalent GitHub CLI commands are:

```sh
# Full MVP area, current date
gh workflow run publish-latest-preview.yml

# Small smoke test
gh workflow run publish-latest-preview.yml \
  -f tiles='32TNS 32TNT 33TUN'
```

After a successful run, verify the atomic pointer and one tile URL:

```sh
curl --fail --show-error "${R2_PUBLIC_BASE_URL}/latest.json"
```

The workflow fetches the published `latest.json` back from R2 as an end-to-end
check, then retains it and the publication receipt as a small GitHub artifact for
seven days. Rendered PNGs and run metadata are also transferred between jobs
as a GitHub artifact retained for one day. Raw GeoTIFFs stay on the render
runner; rendered PNGs are published to R2. None are committed to Git.

## Local publication (optional)

With `pipeline/requirements.txt` installed and the five variables exported,
the same current-date full-area run can be started locally:

```sh
python -m pipeline.preview \
  --raw-dir /tmp/nevaio-gfsc/raw \
  --work-dir /tmp/nevaio-gfsc/work \
  --output-dir /tmp/nevaio-gfsc/output \
  --publish-r2 --keep-runs 7
```

Use an explicit, sufficiently large scratch location instead of `/tmp` if the
machine's temporary volume is small: a full-area window run downloads roughly
1 GB of GeoTIFFs. Never commit them. Omit `--keep-runs` to leave every existing
run in place; it is the only flag here that deletes anything.
