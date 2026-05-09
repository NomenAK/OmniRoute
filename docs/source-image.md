# Source image producer runbook

`NomenAK/OmniRoute` is the canonical source application and GHCR image producer for the OmniRoute runtime split. `NomenAK/OmniRoute#1` is merged into `main`; runtime consumers should consume images from this repository rather than rebuilding or patching source at deploy time.

This document is for source-image publication and validation only. Deployment, host access, patch parity rollout, and runtime source-image consumption are owned by `NomenAK/omniroute-runtime`.

## Publishing model

- Registry: `ghcr.io/nomenak/omniroute` only.
- Workflow: `.github/workflows/docker-publish.yml` (`Publish source image`).
- Runner: `runs-on: [self-hosted, nomenak]`; do not move publishing to GitHub-hosted runners unless the cost model changes.
- Dockerfile target: `runner-cli`.
- Platforms: `linux/amd64`, `linux/arm64`.
- Default runtime command: `node run-standalone.mjs`.
- App port: `20128`.

The `runner-cli` target packages the application plus pinned operator CLIs used by runtime deployments so source builds and runtime hosts stay in parity. It does not include operator authentication, OAuth state, API tokens, host-specific config, SQLite data, logs, backups, or other runtime-owned state.

## Tags and digests

The workflow publishes these GHCR tags:

| Trigger        | Tags                                                                                                                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release        | `ghcr.io/nomenak/omniroute:<release-version>`, `ghcr.io/nomenak/omniroute:sha-<short-sha>`                                                                                   |
| Manual version | `ghcr.io/nomenak/omniroute:<version>`, `ghcr.io/nomenak/omniroute:sha-<short-sha>`                                                                                           |
| Main push      | `ghcr.io/nomenak/omniroute:<package-version>-<short-sha>`, `ghcr.io/nomenak/omniroute:sha-<short-sha>`, `ghcr.io/nomenak/omniroute:main`, `ghcr.io/nomenak/omniroute:latest` |

Use mutable tags (`main`, `latest`, and version tags) for discovery, smoke tests, and human lookup only. Runtime consumers should pin the immutable manifest digest once a candidate has been validated:

```text
ghcr.io/nomenak/omniroute:<tag>@sha256:<digest>
```

Do not record real production digests or host-specific rollout state in this source repository. Track runtime consumption and rollout state in `NomenAK/omniroute-runtime`.

## Manual version publishing

`workflow_dispatch.version` accepts a Docker tag version such as `2.6.0`; a leading `v` is stripped for the image tag. The workflow validates the final Docker tag with GitHub Container Registry-compatible syntax before publishing.

Manual version builds are source-safe:

1. The workflow computes `refs/tags/v<version>` from the manual input.
2. It fetches that tag from `origin`.
3. It fails if the matching tag does not exist.
4. It checks out `refs/tags/v<version>` before preparing tags or building the image.

This prevents publishing `ghcr.io/nomenak/omniroute:<version>` from the wrong commit. If a manual publish is needed, create or verify the matching `v<version>` tag first; do not reuse a version tag for different source.

## No-secrets contract

This source repository and its image producer must stay free of runtime secrets and live state:

- No API keys, OAuth refresh tokens, CLI auth state, SSH material, host credentials, or Tailscale state.
- No production SQLite databases, backups, runtime logs, generated reports, or host-local config.
- No deployment commands or live host procedures in this runbook.
- Runtime auth/data should be mounted or injected by the deployment layer, not baked into the image.

Use `NomenAK/omniroute-runtime` for deployment runbooks, host access, source-image rollout, patch parity tracking, and runtime config ownership.

## Source/runtime boundary

`NomenAK/OmniRoute` owns:

- Application source and tests.
- Docker image build inputs and the `runner-cli` target.
- GHCR publication at `ghcr.io/nomenak/omniroute`.
- Source features that need to be present before runtime adoption, including `MITM_LOCAL_PORT` support.

`NomenAK/omniroute-runtime` owns:

- Deployment and host operations.
- Runtime secrets, auth volumes, databases, backups, and logs.
- Patch parity and rollout sequencing from legacy runtime patches to source.
- Digest pinning and promotion of source images into runtime environments.

`MITM_LOCAL_PORT` support is now in source and covered by `tests/unit/mitm-local-port.test.ts`; runtime docs can reference that support when consuming a pinned source image.

## Operator validation checklist

Before promoting a source image for runtime consumption:

- Confirm the build came from fresh `main`, a release event, or the intended `refs/tags/v<version>` checkout.
- Confirm the workflow ran on `runs-on: [self-hosted, nomenak]`.
- Confirm the pushed image is `ghcr.io/nomenak/omniroute` and not Docker Hub or another registry.
- Confirm the Docker build used target `runner-cli` for both `linux/amd64` and `linux/arm64`.
- Inspect the published manifest and copy the immutable `sha256:<digest>` for the selected tag.
- Record runtime usage as `ghcr.io/nomenak/omniroute:<tag>@sha256:<digest>` in the runtime ops repo, not here.
- Confirm no runtime secrets, auth state, SQLite data, backups, logs, or host-local config were added to source.
- Confirm source-side tests covering required runtime parity pass, including `tests/unit/mitm-local-port.test.ts` when MITM local port behavior is relevant.
- Defer deploy, rollback, host access, and patch parity rollout steps to `NomenAK/omniroute-runtime`.
