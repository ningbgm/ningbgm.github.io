This is an anonymous demonstration for NingBGM: Video-to-Music Generation via Holistic Scene Understanding with Multi-Agent Collaboration.

## Local Preview

Requires Node.js and FFmpeg on PATH. From this directory:

```sh
node scripts/build-site.mjs site-preview
node scripts/serve-site.mjs site-preview 4173
```

Open http://127.0.0.1:4173. A build refuses to overwrite an existing output directory; use a new name for the next build.

## Anonymous Publication

Publish only the generated output directory. It contains the page, local assets, and metadata-cleaned media copies. Do not publish the workspace root: original captions, source media metadata, task records and other internal files are not publication assets.

The page names no venue, author, affiliation, contact, or repository. Fonts and scripts are local; there are no analytics. Metadata removal does not anonymize faces, watermarks, QR codes, speech or other content embedded in media. Review those before external publication. Third-party source identities are not evidence of research-author identity.

Use a neutral hosting account and URL for anonymous publication. A personal account, domain, repository history or hosting profile can still identify an author independently of the page. The noindex directive is advisory, not access control.
