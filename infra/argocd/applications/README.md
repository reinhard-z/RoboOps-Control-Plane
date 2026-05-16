# ArgoCD Applications

This directory contains reference ArgoCD `Application` manifests for RoboOps
software rollout patterns.

ArgoCD is used for software rollout and rollback, not robot mission control.
The Fleet Platform remains responsible for mission dispatch, and the robot-near
edge agent keeps ROS2/DDS local to the robot runtime.

## Edge Agent Reference

`robot-edge-agent-reference.yaml` points at the edge example Kustomize overlay
path under `infra/k8s/edge/overlays/example`. The committed values are
intentionally placeholders:

- the repository URL uses the reserved `.invalid` domain;
- the target revision is a pinned placeholder commit SHA;
- the overlay contains a non-routable Fleet Platform URL and placeholder robot
  identifier;
- automated sync is omitted so applying the reference does not create an
  unattended rollout loop.

For a real environment, keep a private deployment repository or private overlay
that references the edge Kustomize base and owns the environment-specific image
pin, Fleet Platform URL, robot identifier, and any future Secret references.
Do not commit robot-specific values, credentials, or cluster-specific settings
to this public reference. Pin the ArgoCD source revision to a commit SHA or
immutable release tag so each rollout is auditable.
