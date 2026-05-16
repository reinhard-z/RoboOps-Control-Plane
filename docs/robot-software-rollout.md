# Robot Software Rollout

This document defines the narrow GitOps boundary for deploying the robot-near
edge agent software version. It does not change the Fleet Platform protocol and
does not make ArgoCD part of robot mission control.

## Boundary

GitOps deploys software versions. The Fleet Platform dispatches missions.

The edge agent runs near the robot runtime and connects outbound to Fleet
Platform at the existing `/edge/connect?robotId=...` WebSocket boundary. Mission
commands, acknowledgements, telemetry, and reconnect handshakes continue to use
the Fleet Platform protocol.

ROS2/DDS stays local to the robot-near runtime. The Kubernetes and ArgoCD
references do not add a direct cloud-to-ROS2/DDS bridge, hosted robot behavior,
navigation, SLAM, real hardware assumptions, or DDS cloud bridging.

## Reference Manifests

The edge Kubernetes reference lives in `infra/k8s/edge`:

```text
infra/k8s/edge/base
infra/k8s/edge/overlays/example
```

The ArgoCD Application reference lives at:

```text
infra/argocd/applications/robot-edge-agent-reference.yaml
```

The committed Application points at the edge example overlay path with a
reserved `.invalid` repository URL and pinned placeholder revision. It is a
reference shape, not a complete environment. Automated sync is intentionally
omitted so rollout remains an explicit operator action when this file is
adapted.

## Private Environment Overlays

Keep environment-specific robot values out of committed public files. A real
deployment should use a private overlay or private deployment repository that
owns:

- the Fleet Platform base URL for that environment;
- the robot identifier for that robot-near runtime;
- the edge-agent image tag or digest;
- the ArgoCD source revision as a commit SHA or immutable release tag;
- cluster-specific namespace, labels, or annotations;
- any future Secret references for edge authentication.

Do not store robot credentials, production URLs, or private robot identifiers in
the public example overlay. If a future protocol requires authentication, mount
the value from a Kubernetes Secret and let the private environment repository or
cluster secret manager provide it.

A private overlay can vendor this repository's `infra/k8s/edge/base` directory
or reference it as a pinned remote Kustomize base. Pin remote bases to a commit
SHA or release tag so edge rollouts are auditable.

## Image Pinning

Real rollouts should pin the edge-agent image to an immutable version tag or
digest. Do not deploy `latest`.

The example overlay uses:

```text
ghcr.io/example-org/roboops-ros2-edge-agent-cpp:0.1.0
```

Replace that placeholder with a real image reference in the private overlay.
Prefer digest pinning when the registry and deployment process support it, for
example:

```text
ghcr.io/<org>/roboops-ros2-edge-agent-cpp@sha256:<digest>
```

Keep `EDGE_AGENT_VERSION` aligned with the deployed image version so Fleet
Platform telemetry and reconnect handshakes can report the software version a
robot-near runtime is running.

## Rollback

Rollback is image/config rollback only. It is not robot motion control.

Use Git history, ArgoCD history, or a private overlay change to return the edge
agent to a previously validated image tag, digest, or configuration. Rollback
does not dispatch `HOLD_POSITION`, `CANCEL_MISSION`, or any other robot command.
Those remain Fleet Platform mission-dispatch decisions and must follow the
normal command, acknowledgement, idempotency, and audit path.

Example rollback flow:

```sh
git revert <private-overlay-change>
argocd app sync robot-edge-agent-reference
```

Or, when ArgoCD history is available for the adapted environment Application:

```sh
argocd app history robot-edge-agent-reference
argocd app rollback robot-edge-agent-reference <history-id>
```

After rollback, confirm the pod image/config and then use Fleet Platform
telemetry, reconnect handshakes, audit events, and operator workflows to reason
about robot state.

## Validation

Render the public example overlay:

```sh
kubectl kustomize infra/k8s/edge/overlays/example
```

Run a client-side render/apply check for the Kubernetes core resources when
`kubectl` has working API discovery for the current context:

```sh
kubectl kustomize infra/k8s/edge/overlays/example \
  | kubectl apply --dry-run=client --validate=false -f -
```

Some `kubectl apply --dry-run=client` versions still contact the Kubernetes API
server for discovery. If it tries `localhost:8080` or no development cluster is
configured, use `kubectl kustomize` plus YAML parsing, or connect to a
development cluster for API-backed validation.

Run file-level YAML parsing for the edge and ArgoCD references:

```sh
ruby -ryaml -e 'ARGV.each { |path| YAML.load_file(path); puts "ok #{path}" }' \
  infra/k8s/edge/base/*.yaml \
  infra/k8s/edge/overlays/example/*.yaml \
  infra/argocd/applications/*.yaml
```

If installed, run stricter optional checks for rendered Kubernetes resources:

```sh
kubectl kustomize infra/k8s/edge/overlays/example | kubeconform -strict -summary
yamllint infra/k8s/edge infra/argocd/applications
```

With the ArgoCD CRD installed in a development cluster, validate the
Application through the Kubernetes API:

```sh
kubectl apply --dry-run=server \
  -f infra/argocd/applications/robot-edge-agent-reference.yaml
```

The ArgoCD CLI is optional for this reference. If it is not installed locally,
the Application can still be checked as YAML, but ArgoCD-specific behavior must
be validated in a development cluster that has ArgoCD installed.

Local validation limitations:

- it cannot prove a placeholder or private image exists;
- it cannot prove placeholder Fleet Platform URLs are routable;
- it cannot validate private robot values that are intentionally not committed;
- it cannot validate the ArgoCD `Application` against a cluster unless the
  ArgoCD CRD is installed in the current Kubernetes context;
- it does not prove robot behavior, ROS2 graph health, navigation, SLAM, or
  hardware readiness.
