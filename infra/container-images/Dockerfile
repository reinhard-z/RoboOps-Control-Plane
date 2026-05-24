# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS workspace

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /workspace

# Corepack keeps the image build pinned to the pnpm version in package.json.
RUN corepack enable

COPY . .

# Install the whole workspace once from the lockfile; the build stage filters the app graph.
RUN pnpm config set store-dir /pnpm/store && \
  pnpm install --frozen-lockfile

FROM workspace AS build

ARG APP_PACKAGE

# The filter builds the selected runnable app and only its workspace dependencies.
RUN test -n "$APP_PACKAGE" || (echo "APP_PACKAGE build arg is required" >&2; exit 1)
RUN pnpm --filter "$APP_PACKAGE"... build
RUN pnpm --filter "$APP_PACKAGE" deploy --prod --legacy /prod/app

FROM node:26-bookworm-slim AS runtime

ARG APP_PACKAGE

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4010
ENV OPERATOR_UI_HOST=0.0.0.0
ENV OPERATOR_UI_PORT=4020
ENV ROBOOPS_APP_PACKAGE=$APP_PACKAGE

WORKDIR /app

COPY infra/container-images/entrypoint.sh /usr/local/bin/roboops-entrypoint

# Runtime containers do not need root to bind the app ports or process outbox rows.
RUN chmod 0755 /usr/local/bin/roboops-entrypoint && \
  groupadd --system roboops && \
  useradd --system --gid roboops --create-home --home-dir /home/roboops roboops

COPY --from=build --chown=roboops:roboops /prod/app ./

USER roboops

ENTRYPOINT ["/usr/local/bin/roboops-entrypoint"]
