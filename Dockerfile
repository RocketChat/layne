FROM node:22-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime

# Pin tool versions for reproducible builds. Update periodically and verify in staging.
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

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/
COPY config/ ./config/

# /tmp is where Layne clones repos. Declaring it as a VOLUME prevents Docker
# from persisting scan artifacts across container restarts.
VOLUME ["/tmp"]

USER layne

CMD ["node", "src/server.js"]
