#!/usr/bin/env bash
set -euo pipefail

# Agentic Observatory — deploy to DigitalOcean static site
# Pushes to main; DigitalOcean App Platform picks up the push automatically.
#
# Prerequisites:
#   - Git remote "origin" points to the GitHub repo
#   - DigitalOcean App Platform configured to deploy on push to main
#
# Usage: ./deploy.sh

BRANCH="main"

echo "==> Deploying Agentic Observatory"
echo "    Branch: $BRANCH"
echo ""

# Ensure we're on main
CURRENT=$(git branch --show-current)
if [ "$CURRENT" != "$BRANCH" ]; then
  echo "ERROR: Not on $BRANCH (currently on $CURRENT). Switch branches first."
  exit 1
fi

# Check for uncommitted changes
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: Uncommitted changes detected. Commit or stash before deploying."
  exit 1
fi

# Push
echo "==> Pushing to origin/$BRANCH..."
git push origin "$BRANCH"

echo ""
echo "==> Done. DigitalOcean will pick up the push and deploy."
echo "    Check status at: https://cloud.digitalocean.com/apps"
