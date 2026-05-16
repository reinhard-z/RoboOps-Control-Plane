# Edge Kubernetes Reference

This directory contains a k3s-compatible Kubernetes reference for running the
robot-near ROS2 edge agent. It preserves the existing Fleet Platform cloud
contract:

- the edge agent connects outbound to Fleet Platform;
- Fleet Platform remains the `/edge/connect?robotId=...` cloud boundary;
- no cloud workload is given direct ROS2/DDS access;
- no hosted robot, navigation, SLAM, or real hardware assumptions are added.

The current C++ edge agent skeleton logs the intended outbound connection and
exits. These manifests are therefore an operations reference for the long-running
edge-agent image, not a hosted robotics demo.

## Layout

```text
infra/k8s/edge/
  base/
    deployment.yaml
    kustomization.yaml
    namespace.yaml
    service-account.yaml
  overlays/
    example/
      kustomization.yaml
```

The base contains deployable workload shape, labels, resource limits, security
context, and restart policy. It intentionally does not commit environment
values, so apply it through an overlay that generates the
`robot-edge-agent-config` ConfigMap. The example overlay uses placeholder values
only.

## Configuration

The Deployment reads these environment variables from the generated
`robot-edge-agent-config` ConfigMap:

| Key | Environment variable | Purpose |
| --- | --- | --- |
| `fleetPlatformUrl` | `FLEET_PLATFORM_URL` | Fleet Platform base URL used to derive the outbound WebSocket URL. |
| `robotId` | `ROBOT_ID` | Fleet Platform robot identifier for this edge runtime. |
| `edgeAgentVersion` | `EDGE_AGENT_VERSION` | Agent software version reported in protocol messages. |

Do not commit real robot identifiers, Fleet Platform URLs, credentials, or
cluster-specific settings. Create a private overlay or generate the ConfigMap at
deploy time. If a future protocol adds an authentication token, reference it
from a Kubernetes Secret instead of a ConfigMap.

The example overlay uses `https://fleet-platform.example.invalid` and
`robot-placeholder` so it is safe to render in public docs and CI. It is not a
working environment by itself. Kustomize keeps the generated ConfigMap name hash
enabled so changes to these environment values update the Deployment's
`configMapKeyRef` names and roll the Pod.

## Apply Pattern

Render the example overlay:

```sh
kubectl kustomize infra/k8s/edge/overlays/example
```

For a real robot-near environment, create an ignored local overlay so the
relative `../../base` path remains valid and environment values stay out of
committed files:

```sh
mkdir -p infra/k8s/edge/overlays/local-robot-a
cp infra/k8s/edge/overlays/example/kustomization.yaml \
  infra/k8s/edge/overlays/local-robot-a/kustomization.yaml
```

Replace the placeholder `fleetPlatformUrl`, `robotId`, image name, and image tag
with environment-specific values before applying:

```sh
kubectl kustomize infra/k8s/edge/overlays/local-robot-a
kubectl apply -k infra/k8s/edge/overlays/local-robot-a
```

For shared team rollout, keep the environment overlay in a private deployment
repository that vendors this `base` directory or references it as a pinned remote
Git base.

Pin the image to an immutable version tag or digest for real rollouts. Do not
use `latest`.

## Hosted Simulator Difference

The hosted simulator demo runs `apps/cloud-edge-simulator` as a cloud-friendly
fake edge process so reviewers can exercise the incident scenario without ROS2,
Gazebo, robot hardware, or node-local networking.

This reference is for a robot-near runtime. It assumes the agent runs close to
the ROS2 environment and opens the same outbound Fleet Platform edge channel as
the simulator. It does not expose ROS2/DDS through the cloud, and it does not
change the Fleet Platform protocol.

## Probes And Runtime Health

No readiness or liveness probes are configured yet because the current ROS2
edge agent skeleton does not expose a durable health endpoint or supported
health-check command, and no inbound Kubernetes Service routes traffic to it.
The Pod uses `restartPolicy: Always`, so Kubernetes restarts the agent process
when it exits.

Add probes only after the edge image exposes a stable health contract, for
example an internal HTTP endpoint or a documented exec health command. Avoid
probes that depend on ROS2/DDS cloud reachability or require public inbound
ports.

## Local Validation

Install `kubectl` locally when you expect to edit these manifests. It can render
Kustomize overlays without requiring a cluster connection. On macOS with
Homebrew:

```sh
brew install kubectl
```

For stricter static checks, install optional validators:

```sh
brew install kubeconform yamllint
```

Render the example overlay:

```sh
kubectl kustomize infra/k8s/edge/overlays/example
```

The rendered output should include a hashed ConfigMap name such as
`robot-edge-agent-config-...`, and each Deployment `configMapKeyRef.name` should
point to that hashed name.

For offline schema validation, run `kubeconform` against the rendered YAML:

```sh
kubectl kustomize infra/k8s/edge/overlays/example | kubeconform -strict -summary
yamllint infra/k8s/edge
```

With a reachable development cluster or local k3s/kind cluster, use Kubernetes
server-side dry-run validation:

```sh
kubectl apply --dry-run=server -k infra/k8s/edge/overlays/example
```

If `kubectl apply --dry-run=client` or `--dry-run=server` tries to reach
`localhost:8080` and fails to download OpenAPI, no Kubernetes API server is
configured for the current context. Use `kubectl kustomize` plus `kubeconform`
for offline validation, or connect to a development cluster for API-backed
validation.

Without Kubernetes tooling, still run file-level YAML parsing and simple
reference checks. For example:

```sh
ruby -ryaml -e 'ARGV.each { |path| YAML.load_file(path); puts "ok #{path}" }' infra/k8s/edge/base/*.yaml infra/k8s/edge/overlays/example/*.yaml
```

Limitations:

- local validation cannot prove the referenced image exists;
- the example overlay uses intentionally invalid placeholder environment values;
- k3s network policy behavior depends on the installed CNI, so no policy is
  included in this slice;
- ROS2/DDS node-local networking choices are environment-specific and are not
  modeled here.
