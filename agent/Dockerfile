FROM node:22-slim
# LiveKit's native WebRTC library verifies TLS against the system CA bundle.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/agent.js", "start"]
