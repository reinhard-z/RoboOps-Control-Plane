#!/bin/sh
set -eu

if [ "$#" -eq 0 ] && [ "${ROBOOPS_APP_PACKAGE:-}" = "@roboops/event-worker" ]; then
  # The worker needs Postgres to do useful work, so the image defaults to usage output.
  set -- --help
fi

exec node dist/index.js "$@"
