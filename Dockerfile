FROM node:22-slim

# node-pty needs build tools; zip is used by the code project download endpoint;
# bubblewrap sandboxes coder-skill shell commands
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ poppler-utils zip bubblewrap \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application
COPY . .

# Data volume — persists users, config, sessions
VOLUME /app/users /app/config.json

EXPOSE 3737

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3737/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
