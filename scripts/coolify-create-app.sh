#!/usr/bin/env bash
# =============================================================================
# Create the wacrm-wasender application in Coolify (public repo path).
#
# Usage:
#   export COOLIFY_API_TOKEN="1|<your-token>"   # Coolify API token (deploy)
#   bash scripts/coolify-create-app.sh
#
# Requires an existing Coolify project/environment/server (defaults from
# docs/DEPLOYMENT-KNOWLEDGE.md). Creates a new application pointing at
# the PUBLIC fork repo with the Dockerfile build pack.
#
# After it prints the app UUID, add it + the token as GitHub secrets on
# pixarusemperor/wacrm-wasender:
#   gh secret set COOLIFY_API_TOKEN --repo pixarusemperor/wacrm-wasender
#   gh secret set COOLIFY_APP_UUID  --repo pixarusemperor/wacrm-wasender
#   gh secret set COOLIFY_BASE_URL  --repo pixarusemperor/wacrm-wasender
# Then push to main (or `gh workflow run deploy.yml`) to trigger.
# =============================================================================

set -euo pipefail

BASE_URL="${COOLIFY_BASE_URL:-https://coolifyone.orizongroup.online}"
TOKEN="${COOLIFY_API_TOKEN:?Set COOLIFY_API_TOKEN}"

REPO_URL="https://github.com/pixarusemperor/wacrm-wasender.git"
BRANCH="main"
SERVER_UUID="${SERVER_UUID:-ypl10ghx88it0xefro9d3duf}"
PROJECT_UUID="${PROJECT_UUID:-o3kjmy9tmrvviidlvlv842vk}"
ENV_UUID="${ENV_UUID:-anwdebql2ddtufiotv3mcbe7}"

echo "==> Creating Coolify application for ${REPO_URL} (${BRANCH})"

curl -sk -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  "${BASE_URL}/api/v1/applications/public" \
  -d "{
    \"project_uuid\": \"${PROJECT_UUID}\",
    \"environment_uuid\": \"${ENV_UUID}\",
    \"server_uuid\": \"${SERVER_UUID}\",
    \"name\": \"wacrm-wasender\",
    \"build_pack\": \"dockerfile\",
    \"git_repository\": \"${REPO_URL}\",
    \"git_branch\": \"${BRANCH}\",
    \"domains\": \"https://wassflow.orizongroup.online\",
    \"ports_exposes\": \"3000\",
    \"base_directory\": \"/\",
    \"dockerfile_location\": \"/Dockerfile\",
    \"is_auto_deploy_enabled\": true,
    \"is_force_https_enabled\": true
  }" | tee /tmp/coolify-app-response.json | jq .

UUID=$(jq -r '.uuid // empty' /tmp/coolify-app-response.json)
if [ -z "${UUID}" ]; then
  echo "::error::No UUID returned. Check the response above."
  exit 1
fi
echo ""
echo "==> APP UUID: ${UUID}"
echo "==> Set env vars on the app (next step):"
echo "    NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY"
echo "    SUPABASE_SERVICE_ROLE_KEY / WATSSENDER_MASTER_PAT"
echo "    ENGINE_SECRET / WASENDER_BASE_URL / LLM_*"
echo "==> Then add GitHub secrets + push to trigger:"
echo "    gh secret set COOLIFY_APP_UUID --repo pixarusemperor/wacrm-wasender --body \"${UUID}\""
