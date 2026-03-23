#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_PATH="${TEMPLATE_PATH:-$ROOT_DIR/infra/openclaw-runtime.yaml}"
BUCKET="${COPYLOBSTA_TEMPLATE_S3_BUCKET:-copylobsta-templates-373352901751-us-east-1}"
KEY="${COPYLOBSTA_TEMPLATE_S3_KEY:-openclaw-runtime.yaml}"
REGION="${COPYLOBSTA_TEMPLATE_S3_REGION:-us-east-1}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required." >&2
  exit 1
fi

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Template not found: $TEMPLATE_PATH" >&2
  exit 1
fi

if [ -z "$BUCKET" ] || [ -z "$KEY" ] || [ -z "$REGION" ]; then
  echo "Missing S3 destination config (bucket/key/region)." >&2
  exit 1
fi

LOCAL_SHA="$(sha256sum "$TEMPLATE_PATH" | awk '{print $1}')"
SOURCE_COMMIT="${GITHUB_SHA:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)}"
S3_URI="s3://${BUCKET}/${KEY}"

echo "Uploading ${TEMPLATE_PATH} -> ${S3_URI} (region=${REGION})"
aws s3 cp "$TEMPLATE_PATH" "$S3_URI" \
  --region "$REGION" \
  --content-type "application/x-yaml" \
  --cache-control "no-cache" \
  --metadata "template-sha256=${LOCAL_SHA},source-commit=${SOURCE_COMMIT}"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT
aws s3 cp "$S3_URI" "$TMP_FILE" --region "$REGION" >/dev/null
REMOTE_SHA="$(sha256sum "$TMP_FILE" | awk '{print $1}')"
if [ "$LOCAL_SHA" != "$REMOTE_SHA" ]; then
  echo "SHA mismatch after upload: local=$LOCAL_SHA remote=$REMOTE_SHA" >&2
  exit 1
fi

META_SHA="$(aws s3api head-object --bucket "$BUCKET" --key "$KEY" --region "$REGION" --query 'Metadata."template-sha256"' --output text)"
if [ "$META_SHA" != "$LOCAL_SHA" ]; then
  echo "S3 metadata SHA mismatch: local=$LOCAL_SHA metadata=$META_SHA" >&2
  exit 1
fi

echo "Template sync complete."
echo "sha256=${LOCAL_SHA}"
echo "commit=${SOURCE_COMMIT}"
