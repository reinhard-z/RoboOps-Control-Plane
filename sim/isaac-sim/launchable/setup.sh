#!/usr/bin/env bash
set -euo pipefail

# Bootstraps the upstream Isaac Launchable template beside the RoboOps checkout.
workspace_dir="${WORKSPACE_DIR:-${HOME}}"
isaac_launchable_repo="${ISAAC_LAUNCHABLE_REPO:-https://github.com/isaac-sim/isaac-launchable.git}"
isaac_launchable_dir="${ISAAC_LAUNCHABLE_DIR:-${workspace_dir}/isaac-launchable}"
roboops_dir="${ROBOOPS_DIR:-${workspace_dir}/RoboOps-Control-Plane}"
roboops_repo_url="${ROBOOPS_REPO_URL:-}"

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: ${name}" >&2
    exit 1
  fi
}

clone_if_missing() {
  local repo_url="$1"
  local target_dir="$2"
  local label="$3"

  if [ -d "${target_dir}/.git" ]; then
    echo "${label} already exists at ${target_dir}"
    return
  fi

  if [ -e "${target_dir}" ]; then
    echo "${label} target exists but is not a git checkout: ${target_dir}" >&2
    exit 1
  fi

  git clone "${repo_url}" "${target_dir}"
}

require_command git
require_command docker
docker compose version >/dev/null

mkdir -p "${workspace_dir}"

clone_if_missing "${isaac_launchable_repo}" "${isaac_launchable_dir}" "Isaac Launchable"

if [ ! -d "${roboops_dir}/.git" ]; then
  if [ -z "${roboops_repo_url}" ]; then
    echo "RoboOps checkout not found at ${roboops_dir}."
    echo "Set ROBOOPS_REPO_URL before running this script if the repo should be cloned automatically."
  else
    clone_if_missing "${roboops_repo_url}" "${roboops_dir}" "RoboOps"
  fi
else
  echo "RoboOps checkout already exists at ${roboops_dir}"
fi

cd "${isaac_launchable_dir}/isaac-lab"
docker compose up -d

cat <<EOF

Isaac Launchable services requested.

Next checks:
  cd ${isaac_launchable_dir}/isaac-lab
  docker compose ps

Start the streamed Isaac Sim app from the browser VS Code terminal:
  ACCEPT_EULA=y /isaac-sim/runheadless.sh

If using SSH to the Brev host, enter the container first:
  cd ${isaac_launchable_dir}/isaac-lab
  docker compose exec vscode bash

Open the Brev secure link in a second tab and change the path to:
  /viewer

Then run RoboOps probes from:
  ${roboops_dir}
EOF
