# Time Global Tech Monitor - single image, role chosen at runtime (web | worker | all)
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

# Worker image adds Playwright + Chromium for synthetic browser tests
FROM mcr.microsoft.com/playwright:v1.49.0-jammy AS browser
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser
CMD ["node", "src/server.js", "--role=worker"]
