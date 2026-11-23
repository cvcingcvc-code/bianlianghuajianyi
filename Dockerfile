# Production Dockerfile for Binance Trader
FROM node:22-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production

# Install build/curl utilities for healthchecks
RUN apk add --no-cache wget

# Copy package manifests and install production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source code and resources
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY data/funding-real/ ./data/funding-real/
COPY data/holdout-2026/ ./data/holdout-2026/

# Create runtime directories for state and logs
RUN mkdir -p /app/data /app/logs

# Expose default Web Dashboard & command port
EXPOSE 3000

# Container healthcheck querying local dashboard state
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/state > /dev/null || exit 1

# Start Binance Trader bot
CMD ["node", "src/index.js"]
