#!/usr/bin/env bash
# Purpose: upload a built frontend to its S3 bucket with the right Cache-Control per file,
#          and delete what the build no longer contains. Called by deploy-frontend.sh.
# Usage:   ./bin/upload-frontend.sh BUILD_DIR BUCKET [extra aws arguments]
#
# - assets/  Vite names these files after a hash of their content, so a name never changes
#            meaning: browsers and CloudFront may keep them for a year (immutable).
# - the rest index.html and the other root files keep their names between releases, so they
#            must be revalidated every time (no-cache), or a release would not be seen.

set -euo pipefail

BUILD_DIR="${1:?Usage: $0 BUILD_DIR BUCKET [extra aws arguments]}"
BUCKET="${2:?Usage: $0 BUILD_DIR BUCKET [extra aws arguments]}"
shift 2

IMMUTABLE="public, max-age=31536000, immutable"
REVALIDATE="no-cache"

[ -f "$BUILD_DIR/index.html" ] || { echo "ERROR: $BUILD_DIR has no index.html"; exit 1; }

# The hashed files first, so the new index.html never points at files that are not there yet.
# cp, not sync: sync skips a file that is already in the bucket, which would leave it with
# whatever Cache-Control an earlier release gave it.
if [ -d "$BUILD_DIR/assets" ]; then
    aws s3 cp "$BUILD_DIR/assets/" "s3://$BUCKET/assets/" --recursive \
        --cache-control "$IMMUTABLE" "$@"
fi

aws s3 cp "$BUILD_DIR/" "s3://$BUCKET/" --recursive --exclude "assets/*" \
    --cache-control "$REVALIDATE" "$@"

# Everything is uploaded, so this sync only deletes what the build no longer has
# (--size-only: nothing just uploaded differs in size, so nothing is uploaded again).
aws s3 sync "$BUILD_DIR/" "s3://$BUCKET/" --delete --size-only "$@"
