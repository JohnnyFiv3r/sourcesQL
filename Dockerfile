# Exact multi-architecture Python 3.12.14 image, matching the observed Flight runtime.
ARG PYTHON_IMAGE=python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
FROM ${PYTHON_IMAGE} AS builder

ENV UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /workspace
RUN python -m pip install --no-cache-dir uv==0.7.18
COPY pyproject.toml uv.lock README.md LICENSE NOTICE ./
RUN --mount=type=cache,id=sourcesql-uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY src ./src
# The wheel bundles reviewed cloud setup templates as well as the engine.
COPY hatch_build.py ./
COPY hosted/setup.mjs hosted/personal-cloud.mjs ./hosted/
COPY hosted/flight/build.py hosted/flight/runner.py hosted/flight/exa_profile.py ./hosted/flight/
COPY apps/research ./apps/research
RUN --mount=type=cache,id=sourcesql-uv,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

# Qualification contains fixture tests and development tools; runtime does not.
FROM builder AS qualification
RUN --mount=type=cache,id=sourcesql-uv,target=/root/.cache/uv \
    uv sync --frozen --no-editable
COPY tests ./tests
COPY examples ./examples
COPY hosted/flight/tests ./hosted/flight/tests
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    SOURCESQL_DATA_DIR=/tmp/sourcesql-engine
USER 10001:10001
CMD ["python", "-m", "pytest", "-q", "-ra", "-p", "no:cacheprovider", "tests", "hosted/flight/tests"]

FROM ${PYTHON_IMAGE} AS runtime
COPY --from=builder /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/tmp \
    SOURCESQL_DATA_DIR=/data/engine
RUN mkdir -p /data && chown 10001:10001 /data
WORKDIR /data
USER 10001:10001
ENTRYPOINT ["sourcesql"]
CMD ["demo", "--profile", "fixture", "--output", "/data/demo"]

FROM ${NODE_IMAGE} AS app-builder
WORKDIR /workspace/apps/research
COPY apps/research/package.json apps/research/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/research ./
RUN npm run build:vercel && npx tsc --noEmit false --outDir compiled

# Full existing app tests run against the actual installed Linux engine.
FROM qualification AS app-qualification
USER 0:0
COPY --from=app-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=app-builder /workspace/apps/research /workspace/apps/research
COPY scripts/qualify-motherduck.mts scripts/qualify-motherduck-app.mts scripts/qualify-exa-hosted.mts /workspace/scripts/
ENV SOURCESQL_PYTHON=/opt/venv/bin/python
WORKDIR /workspace/apps/research
RUN node --version
USER 10001:10001
CMD ["sh", "-c", "node --import tsx --test --test-concurrency=1 tests/*.test.ts"]

# Compiled JS plus production-only Node dependencies; no npm/tsx compiler at runtime.
FROM app-builder AS app-production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM runtime AS app-runtime
USER 0:0
COPY --from=app-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=app-production-dependencies /workspace/apps/research/node_modules /workspace/apps/research/node_modules
COPY --from=app-builder /workspace/apps/research/package.json /workspace/apps/research/package.json
COPY --from=app-builder /workspace/apps/research/compiled/server /workspace/apps/research/server
COPY --from=app-builder /workspace/apps/research/compiled/src /workspace/apps/research/src
COPY --from=app-builder /workspace/apps/research/fixtures /workspace/apps/research/fixtures
COPY --from=app-builder /workspace/apps/research/dist /workspace/apps/research/dist
COPY --from=app-builder /workspace/apps/research/.vercel-assets/.ui-builds /opt/sourcesql-ui-archives
COPY --from=app-builder /workspace/apps/research/src/fonts/*LICENSE.txt /usr/share/licenses/sourcesql/fonts/
RUN mkdir -p /data/research && chown -R 10001:10001 /data && \
    ln -s /data/research /workspace/apps/research/.data && \
    ln -s /data/ui-builds /workspace/apps/research/.ui-builds && node --version
RUN <<'SH'
cat > /usr/local/bin/sourcesql-app-entrypoint <<'ENTRYPOINT'
#!/bin/sh
set -eu
mkdir -p /data/research /data/ui-builds
for bundle in /opt/sourcesql-ui-archives/research-*.html; do
  name="$(basename "$bundle")"
  if [ ! -f "/data/ui-builds/$name" ]; then
    temporary="/data/ui-builds/.$name.$$"
    cp "$bundle" "$temporary"
    mv -n "$temporary" "/data/ui-builds/$name"
    rm -f "$temporary"
  fi
done
exec node /workspace/apps/research/server/main.js "$@"
ENTRYPOINT
chmod 755 /usr/local/bin/sourcesql-app-entrypoint
SH
ENV SOURCESQL_PYTHON=/opt/venv/bin/python \
    SOURCESQL_ALLOW_PRIVATE=0 \
    RESEARCH_ALLOW_PRIVATE_HOST_DISCLOSURE=0 \
    RESEARCH_BIND_HOST=0.0.0.0 \
    PORT=3117
WORKDIR /workspace
USER 10001:10001
EXPOSE 3117
ENTRYPOINT ["/usr/local/bin/sourcesql-app-entrypoint"]
CMD []
