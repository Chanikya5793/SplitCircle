# splitcircle-core MCP — Cloud Run image
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
# Use npm install (no lockfile committed for the sub-package); pin in CI as needed.
RUN npm install --omit=dev=false
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
# Cloud Run sets PORT; default 8080.
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
