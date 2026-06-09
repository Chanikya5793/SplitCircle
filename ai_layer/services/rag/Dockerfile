# splitcircle-rag-service — Cloud Run image
#
# The service uses bundler-style (extensionless) imports, so it runs directly via
# tsx rather than a tsc emit step (Node ESM would need .js extensions). `npm run
# build` stays a typecheck gate; the container runs the TS entrypoint with tsx.
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
# No lockfile committed for the sub-package; pin in CI as needed.
RUN npm install --omit=dev
COPY . .
# Cloud Run sets PORT; the RAG server defaults to 8081.
EXPOSE 8081
USER node
CMD ["npx", "tsx", "server.ts"]
