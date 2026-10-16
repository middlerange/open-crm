FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
ARG VP_VERSION=0.1.24
ENV VP_HOME=/opt/vite-plus
ENV CI=true
ENV PATH="/opt/vite-plus/bin:${PATH}"
RUN curl -fsSL https://vite.plus -o /tmp/install-vp.sh \
  && VP_NODE_MANAGER=no bash /tmp/install-vp.sh \
  && rm /tmp/install-vp.sh

COPY package.json pnpm-lock.yaml ./
RUN vp install --frozen-lockfile

COPY . .
RUN vp run build
RUN vp install --prod --frozen-lockfile

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/migrations ./migrations

RUN groupadd --system orbit && useradd --system --gid orbit --home-dir /app orbit \
  && chown -R orbit:orbit /app
USER orbit

EXPOSE 8787
CMD ["node", "dist-server/index.mjs"]
