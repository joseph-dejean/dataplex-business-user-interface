#!/bin/sh
set -e

echo "[ENTRYPOINT] Starting..."
echo "[ENTRYPOINT] =============================================="
echo "[ENTRYPOINT] VITE_API_URL=${VITE_API_URL}"
echo "[ENTRYPOINT] VITE_API_VERSION=${VITE_API_VERSION}"
echo "[ENTRYPOINT] =============================================="

# Aggressively sanitize the variables if they are set to literal 'undefined', 'null', or contain them
case "$VITE_API_URL" in
  undefined*) VITE_API_URL="/api" ;;
  null*)      VITE_API_URL="/api" ;;
  "")         VITE_API_URL="/api" ;;
esac

case "$VITE_API_VERSION" in
  undefined*) VITE_API_VERSION="v1" ;;
  null*)      VITE_API_VERSION="v1" ;;
  "")         VITE_API_VERSION="v1" ;;
esac

echo "[ENTRYPOINT] Sanitized VITE_API_URL=${VITE_API_URL}"
echo "[ENTRYPOINT] Sanitized VITE_API_VERSION=${VITE_API_VERSION}"

ASSETS_DIR=/app/dist/assets

echo "[ENTRYPOINT] Replacing environment variables in JS files..."

# Use a simpler find syntax that works in Alpine ash
for file in $(find $ASSETS_DIR -type f -name "*.js"); do
  echo "[ENTRYPOINT] Processing $file"
  # Replace placeholders with actual environment variable values
  sed -i "s|__VITE_API_URL__|${VITE_API_URL}|g" "$file"
  sed -i "s|__VITE_API_VERSION__|${VITE_API_VERSION}|g" "$file"
  sed -i "s|__VITE_ADMIN_EMAIL__|${VITE_ADMIN_EMAIL}|g" "$file"
  sed -i "s|__VITE_GOOGLE_PROJECT_ID__|${VITE_GOOGLE_PROJECT_ID}|g" "$file"
  sed -i "s|__VITE_GOOGLE_CLIENT_ID__|${VITE_GOOGLE_CLIENT_ID}|g" "$file"
  sed -i "s|__VITE_GOOGLE_CLIENT_SECRET__|${VITE_GOOGLE_CLIENT_SECRET}|g" "$file"
  sed -i "s|__VITE_GOOGLE_REDIRECT_URI__|${VITE_GOOGLE_REDIRECT_URI}|g" "$file"
done

echo "[ENTRYPOINT] Environment setup done, starting server..."
echo "[ENTRYPOINT] PORT=${PORT:-8080}"
echo "[ENTRYPOINT] GOOGLE_CLOUD_PROJECT_ID=${GOOGLE_CLOUD_PROJECT_ID}"

# Start the Node.js server
exec npm start
