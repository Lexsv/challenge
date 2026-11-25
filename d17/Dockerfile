FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Assemble the Linux runtime without inheriting build, package-manager or OS history.
RUN set -eu; \
    install -D /usr/local/bin/node /runtime/usr/local/bin/node; \
    ldd /usr/local/bin/node > /tmp/node-libraries; \
    awk '{for (i=1;i<=NF;i++) if ($i ~ /^\//) print $i}' /tmp/node-libraries | sort -u | \
      while read -r lib; do install -D "$lib" "/runtime$lib"; done; \
    mkdir -p /runtime/var/lib/scheduler; \
    chown 1000:1000 /runtime/var/lib/scheduler; chmod 700 /runtime/var/lib/scheduler

FROM scratch
COPY --from=build /runtime/ /
WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist/src ./dist/src
ENV NODE_ENV=production \
    DATABASE_PATH=/var/lib/scheduler/tasks.sqlite \
    LOG_DIR=/var/lib/scheduler/logs
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "dist/src/service.js"]
