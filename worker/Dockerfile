# VidRush render worker — Node + ffmpeg. Runs the tier-1 renderer behind HTTP.
FROM node:20-slim

# ffmpeg (+ fonts for the ASS karaoke captions). Chromium is only needed once the
# HyperFrames hook tier is wired in; add it then to keep this image lean.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]
