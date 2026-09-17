FROM node:26-slim

WORKDIR /app

# Install all dependencies (tsx/typescript are needed at runtime to execute TS directly).
# NODE_ENV must NOT be production during npm ci, or devDependencies (tsx) get skipped.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

ENV NODE_ENV=production

# Copy application source
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples

# Non-root user for safety
USER node

# Healthcheck reads scanner and subscription heartbeats from the watcher.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node --import tsx src/healthcheck.ts

CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "src/cli.ts", "scan", "--watch", "--interval", "60", "--log", "/data/opportunities.jsonl"]
