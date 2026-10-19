FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && npm prune --omit=dev
ENV NODE_ENV=production
CMD ["node", "dist/agent.js", "start"]
