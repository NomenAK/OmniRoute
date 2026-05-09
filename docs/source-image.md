# Source image publishing

`NomenAK/OmniRoute` is the canonical source application and container image producer. The ops/runtime repository, `NomenAK/omniroute-runtime`, should consume versioned tags or immutable digests from this repository instead of rebuilding or patching source at deploy time.

## Image

- Registry: `ghcr.io/nomenak/omniroute`
- Dockerfile target: `runner-cli`
- Architectures: `linux/amd64`, `linux/arm64`
- Default runtime command: `node run-standalone.mjs`
- App port: `20128`

The `runner-cli` target includes the app plus globally installed operator CLI tools used by runtime deployments: Codex, Claude Code, Droid, OpenClaw, Cline, Kilo Code CLI, Qwen Code, and Gemini CLI. The image does not include CLI authentication, OAuth state, tokens, or host-specific config. Operators should persist CLI auth and runtime data outside the image with volumes or platform secrets.

## Tags

The publish workflow pushes GHCR tags suitable for ops consumption:

- Release or manual version: `ghcr.io/nomenak/omniroute:<version>`
- Non-versioned main build fallback: `ghcr.io/nomenak/omniroute:<package-version>-<short-sha>`
- Commit identity: `ghcr.io/nomenak/omniroute:sha-<short-sha>`
- Main branch convenience tags: `ghcr.io/nomenak/omniroute:main` and `ghcr.io/nomenak/omniroute:latest`

Mutable tags are for discovery and smoke testing. Runtime deployments should pin by digest when ready, for example `ghcr.io/nomenak/omniroute@sha256:<digest>`, so rollouts are reproducible.

## Runtime split status

`NomenAK/omniroute-runtime` remains the deployment and operations layer. Existing runtime patches in `omniroute-runtime/patch.mjs` are being retired or migrated into source patch-by-patch; this source image does not claim parity with every historical runtime patch yet.
