# Synthea and JDK acquisition (2026-10-24)

- **Approval (owner, in chat, 2026-10-24):** "Yes: download synthea-with-dependencies.jar v4.0.0 from the official synthetichealth GitHub release (verify its SHA-256 before running it) and pull eclipse-temurin:17.0.20.1_1-jdk-jammy by its pinned arm64 digest. Loopback only, synthetic data only, generation offline."
- **Purpose:** the natural synthetic corpus for the S8 quickstart seed and the S11 measurement charts (`proposals/m3b-s8s9-design.md` D2, `proposals/m3b-integration-plan.md` A6).
- **Acquired by:** root. Neither artifact has been executed yet; generation runs only through the pinned generator, offline, inside the pinned image.

## Synthea release JAR

| Item | Value |
| --- | --- |
| Release | `synthetichealth/synthea` `v4.0.0` (published 2026-03-05T22:37:08Z, not a prerelease), tag commit `0185c09ea9d10a822c6f5f3ef9bdcbcbe960c813` |
| Source URL | `https://github.com/synthetichealth/synthea/releases/download/v4.0.0/synthea-with-dependencies.jar` (HTTPS only, TLS ≥1.2, redirects followed to GitHub's release storage) |
| Downloaded | 2026-10-24T00:37:08Z to 00:37:12Z, into a new empty directory `.local/synthea/v4.0.0/` (gitignored) |
| Size | 201,164,144 bytes, equal to the release asset size |
| SHA-256 (local) | `ed43c20ad40ba5c3bc724503a5af032715fe3c491620b766148e7c2361e6ecc1`, equal to the digest GitHub publishes for the asset |
| Local state | file made read-only; not executed |

## JDK image

| Item | Value |
| --- | --- |
| Image | `eclipse-temurin:17.0.20.1_1-jdk-jammy`, index `sha256:73ed442231ec66cfe48cae0b263ce619a75ab96d162ab325f38fc0a269ee3aab` |
| Pulled by | the linux/arm64 child digest, `docker pull eclipse-temurin@sha256:f6838d4bc55df9a3b03783e04f1d26b3c163b96faf153e3a54468ec3fdcbd7f5`, 2026-10-24T00:37:14Z to 00:37:27Z |
| Runtime | Colima 0.10.3, Docker Engine 29.5.2, macOS arm64; a temporary empty Docker client configuration (the user's own Docker configuration is unchanged) |
| Local image | id `sha256:f6838d4bc55df9a3b03783e04f1d26b3c163b96faf153e3a54468ec3fdcbd7f5`, linux/arm64, 194,434,694 bytes (the five compressed layers, 194,426,706 bytes, plus the 6,043-byte config and 1,945-byte manifest); `JAVA_VERSION=jdk-17.0.20.1+1` |
| Local state | not run |

## Rules for use

Generation runs with `--pull never`, networking disabled and the JAR mounted read-only after its SHA-256 is checked again; outputs are synthetic and stay local until the reviewed transform; seeding targets only a helper-owned HAPI instance on `127.0.0.1:18080`. No other host is contacted.
