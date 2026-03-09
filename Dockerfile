# ── Stage 1: deps ─────────────────────────────────────────────────────────────
# Install production dependencies in a clean layer so they can be cached
# separately from the application source.
FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# Final image — minimal Alpine base with only what is needed at runtime.
FROM node:22-alpine AS runtime

# Pin tool versions for reproducible builds. Update periodically and
# verify the new version in a staging environment before deploying.
# Security tools — installed as root before dropping privileges.
# trufflehog and semgrep are the only external binaries Layne shells out to.
RUN apk add --no-cache \
    git \
    python3 \
    py3-pip \
    wget \
    && python3 -m pip install --break-system-packages semgrep==1.154.0 \
    && wget -qO- "https://github.com/trufflesecurity/trufflehog/releases/download/v3.93.7/trufflehog_3.93.7_linux_amd64.tar.gz" \
       | tar -xz -C /usr/local/bin trufflehog \
    && chmod +x /usr/local/bin/trufflehog

# Run as a non-root user so a compromised container cannot write to the host.
RUN addgroup -S layne && adduser -S layne -G layne

WORKDIR /app

# Copy pre-built deps from the deps stage, then the application source.
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY config/ ./config/

# /tmp is writable by all users; Layne clones repos there and cleans up after itself.
# Explicitly declare it as a volume so Docker does not persist scan artifacts.
VOLUME ["/tmp"]

USER layne

# CMD is overridden per service in docker-compose.yml.
# Default to the webhook server so the image is useful standalone.
CMD ["node", "src/server.js"]
