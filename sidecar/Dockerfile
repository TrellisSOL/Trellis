# Trellis sidecar image.
#
# Reproducibility: the base image is pinned by digest, dependencies come from the committed lockfile
# (`--frozen-lockfile --ignore-scripts`), nothing is fetched at run time, and every file's mtime and mode is
# normalised from SOURCE_DATE_EPOCH. Build with a fixed epoch and timestamp rewriting so two builds of the same
# commit give the same image digest:
#
#   SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
#   docker buildx build \
#     --build-arg SOURCE_DATE_EPOCH \
#     --output type=image,name=<registry>/sidecar,push=true,rewrite-timestamp=true \
#     sidecar/
#
# Then pin the resulting digest (image: <registry>/sidecar@sha256:...) in the compose file you deploy, and set
# SIDECAR_IMAGE_DIGEST to the same value so it is bound into the attestation.

ARG BUN_IMAGE=oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts --minimum-release-age 604800

FROM ${BUN_IMAGE} AS stage
ARG SOURCE_DATE_EPOCH=0
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# Normalise metadata so the layer content does not depend on when or where the build ran.
RUN find /app -type d -exec chmod 0755 {} + \
 && find /app -type f -exec chmod 0644 {} + \
 && find /app -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +

# ---- GPU image: begin ------------------------------------------------------------------------------------------------
# Optional target for hosts that run NVIDIA GPUs in confidential-computing mode (sidecar.yaml: gpu.cc_mode "on"). It is
# the default image below plus `nvattest`, the command line of the NVIDIA Attestation SDK, which the sidecar runs to
# collect each GPU's attestation report (src/attestation/gpu.ts). A plain `docker build` never builds these two stages:
# the default image is the last stage of this file and is unchanged by them.
#
#   SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
#   docker buildx build --target gpu --build-arg SOURCE_DATE_EPOCH \
#     --output type=image,name=<registry>/sidecar-gpu,push=true,rewrite-timestamp=true \
#     sidecar/
#
# nvattest is built from NVIDIA's public source at one commit (github.com/NVIDIA/attestation-sdk, tag 2026.06.09, which
# is nvattest 1.2.2: the version whose `collect-evidence --device gpu --nonce <hex> --format json` the sidecar was
# written against). The SDK's own build pins the OpenSSL, xmlsec and curl sources it links statically by sha256. What
# is NOT pinned by hash here: the Debian packages of the toolchain and of the two runtime libraries, the Rust
# toolchain (by version only) and the SDK's git dependencies (by tag). So two builds of this target can differ; pin the
# digest of the image you built, as for the default image, and that digest is what the quote commits to.
# At run time the NVIDIA container runtime must mount nvidia-smi and the management library (NVML) into the container:
# reserve the GPUs for the sidecar service with the `utility` capability (deploy/graft/dstack-cloud has a template).
FROM ${BUN_IMAGE} AS nvattest-build
ARG NVAT_COMMIT=9d12801cea8a198ea0f29640dfaf8a4017c841c5
ARG RUST_VERSION=1.90.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates clang cmake curl git libxml2-dev make perl pkg-config xz-utils zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
# The SDK embeds a policy engine written in Rust.
RUN curl --proto '=https' --tlsv1.2 -fsS https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_VERSION}"
ENV PATH=/root/.cargo/bin:${PATH} \
    CC=clang \
    CXX=clang++
WORKDIR /src
RUN git init -q . \
 && git remote add origin https://github.com/NVIDIA/attestation-sdk.git \
 && git fetch -q --depth 1 origin "${NVAT_COMMIT}" \
 && git checkout -q FETCH_HEAD \
 && test "$(git rev-parse HEAD)" = "${NVAT_COMMIT}"
RUN cmake -S nv-attestation-cli -B /build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/nvat -DCMAKE_INSTALL_LIBDIR=lib \
 && cmake --build /build -j "$(nproc)" \
 && cmake --install /build

FROM ${BUN_IMAGE} AS gpu
WORKDIR /app
ENV NODE_ENV=production \
    SIDECAR_CONFIG=/etc/sidecar/sidecar.yaml
# libnvat links libxml2 and zlib dynamically; everything else it needs is linked in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libxml2 zlib1g \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt /var/log/apt /var/log/dpkg.log
COPY --from=nvattest-build /opt/nvat/bin/nvattest /usr/local/bin/nvattest
# The directory, not a glob: it holds libnvat.so.<version> and its two symbolic links, which a glob would copy three times.
COPY --from=nvattest-build /opt/nvat/lib/ /usr/local/lib/
# Fails the build if the binary cannot load its libraries.
RUN ldconfig && nvattest version
COPY --from=stage /app /app
USER bun
EXPOSE 8443
HEALTHCHECK --interval=15s --timeout=6s --start-period=3600s --retries=3 CMD ["bun", "src/main.ts", "healthcheck"]
ENTRYPOINT ["bun", "src/main.ts"]
CMD ["serve"]
# ---- GPU image: end --------------------------------------------------------------------------------------------------

FROM ${BUN_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    SIDECAR_CONFIG=/etc/sidecar/sidecar.yaml
COPY --from=stage /app /app
# The default user cannot open the configfs-tsm interface; the `tdx` provider needs `user: root` (see the README).
USER bun
EXPOSE 8443
HEALTHCHECK --interval=15s --timeout=6s --start-period=3600s --retries=3 CMD ["bun", "src/main.ts", "healthcheck"]
ENTRYPOINT ["bun", "src/main.ts"]
CMD ["serve"]
