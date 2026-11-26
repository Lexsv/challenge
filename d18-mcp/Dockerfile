FROM node:24-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-alpine AS runtime
ENV NODE_ENV=production DATABASE_PATH=/var/lib/weather/weather.sqlite
WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist/src ./dist/src
RUN mkdir -p /var/lib/weather && chown node:node /var/lib/weather && chmod 700 /var/lib/weather
USER node
CMD ["node", "dist/src/main.js"]
