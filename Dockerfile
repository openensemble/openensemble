FROM node:22-slim

# node-pty needs build tools; zip is used by the code project download endpoint;
# git and ripgrep support repository/search tools; bubblewrap is installed for
# operators who provide a compatible nested-sandbox profile (Docker's default
# security policy does not permit it); ffmpeg handles uploaded media and
# normalizes remote TTS audio for voice devices; openssl creates the
# first-run HTTPS certificate at container startup (never during image build).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ poppler-utils zip bubblewrap ffmpeg openssl git ripgrep \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json* ./
# The root postinstall imports application files that are copied in the next
# layer. Install packages without lifecycle hooks first, then rebuild native
# dependencies and fetch bundled models after source is present.
RUN npm ci --omit=dev --ignore-scripts

# Copy application
COPY . .
RUN mkdir -p /opt/openensemble-plugins \
    && cp -a plugins/markets plugins/news /opt/openensemble-plugins/ \
    && npm rebuild --omit=dev && node scripts/fetch-models.mjs \
    && chmod 755 scripts/docker-entrypoint.sh

# Named volumes keep profiles, plugins, runtime state, and the generated TLS
# key outside both the image layers and the disposable container filesystem.
VOLUME /app/users /app/plugins /app/tls /app/docker-data

EXPOSE 3737 3739

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3737/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
