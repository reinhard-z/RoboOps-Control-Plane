# AWS/Kubernetes Demo Runbook

This runbook is for collecting portfolio evidence from a short-lived
AWS/Kubernetes demo. It is not a production hosting guide and does not add app
behavior, robot hardware support, or infrastructure manifests.

Use it after the Fleet Platform, Operator UI, and cloud-edge simulator images
are available in a registry and an environment-specific Kubernetes deployment
has been prepared outside the public reference manifests.

## Demo Boundary

The hosted AWS demo uses:

- Fleet Platform for mission dispatch, REST reads, SSE UI events, edge
  WebSocket handling, audit events, and metrics;
- Operator UI for the browser evidence view;
- cloud-edge simulator as the demo robot.

The simulator is the demo robot. It is not real hardware, not a hosted ROS2
robot, and not a Gazebo or physical navigation stack.

GitOps, when used, deploys software versions and configuration to Kubernetes.
Fleet Platform dispatches missions. ArgoCD does not control robot motion.

ROS2/DDS stays local to robot-near runtime. No AWS workload exposes ROS2/DDS,
and the Fleet Platform does not create a direct cloud-to-ROS2/DDS bridge.

This demo provides no safety certification, no hosted robot, and no direct
cloud-to-ROS2/DDS path. Do not describe it as full Open-RMF, VDA5050,
MassRobotics, AI autonomy, real hardware integration, navigation, SLAM, or a
production safety system.

## Prerequisites

- AWS access for the account, region, and cluster used for the recording.
- Kubernetes access with the intended `kubectl` context selected.
- ArgoCD access if the environment is GitOps-managed.
- Container images available for:
  - `@roboops/fleet-platform`;
  - `@roboops/operator-ui`;
  - `@roboops/cloud-edge-simulator`;
  - `@roboops/event-worker` only if Postgres/outbox publishing is part of the
    hosted story.
- Image references pinned to immutable tags or digests for the evidence run.
- A high-entropy demo token stored as a Kubernetes Secret and injected as
  `DEMO_ADMIN_TOKEN` for Fleet Platform and `OPERATOR_DEMO_ADMIN_TOKEN` for
  Operator UI when demo controls are enabled.
- Exact Operator UI browser origin configured as Fleet Platform CORS allowlist:

```text
CORS_ALLOW_ORIGIN=https://<operator-ui-host>
```

Use the browser origin only: scheme, host, and optional port. Do not include a
path, query string, trailing slash, or wildcard for the evidence run.

Expected runtime URLs:

```text
FLEET_PLATFORM_URL=https://<fleet-platform-host>
OPERATOR_UI_ORIGIN=https://<operator-ui-host>
ROBOT_ID=robot-a
EDGE_AGENT_VERSION=sim-0.1.0
SIM_SCENARIO=normal
```

For a public browser recording, protect the URL at the provider, load balancer,
or reverse-proxy layer while capture is in progress. The demo token guards reset
and fault endpoints, but browser-delivered demo controls are still part of a
demo workflow and should not be treated as user authentication.

## Deployment Smoke Checks

Set the environment values used by the checks:

```sh
export NAMESPACE=roboops-demo
export FLEET_PLATFORM_URL=https://<fleet-platform-host>
export OPERATOR_UI_ORIGIN=https://<operator-ui-host>
export ROBOT_ID=robot-a
```

Verify that `kubectl` points at the intended AWS/Kubernetes cluster:

```sh
kubectl config current-context
kubectl get namespace "$NAMESPACE"
```

Verify namespace resources. Adjust resource names to match the private overlay
or deployment manifests used for the hosted run:

```sh
kubectl -n "$NAMESPACE" get deploy,svc,pod
kubectl -n "$NAMESPACE" get secret
kubectl -n "$NAMESPACE" describe deploy fleet-platform
kubectl -n "$NAMESPACE" describe deploy operator-ui
kubectl -n "$NAMESPACE" describe deploy cloud-edge-simulator
```

If ArgoCD manages the namespace, capture sync and health before interacting
with the demo:

```sh
argocd app get <app-name>
argocd app history <app-name>
```

When the ArgoCD CLI is not available locally, use Kubernetes reads from the
cluster where ArgoCD is installed:

```sh
kubectl -n argocd get applications.argoproj.io
kubectl -n argocd describe application <app-name>
```

Verify Fleet Platform liveness and readiness:

```sh
curl -fsS "$FLEET_PLATFORM_URL/health/live"
curl -fsS "$FLEET_PLATFORM_URL/health/ready"
```

Verify Operator UI serves the browser app:

```sh
curl -fsS "$OPERATOR_UI_ORIGIN/health/live"
```

Open `OPERATOR_UI_ORIGIN` in a browser and confirm the API status and stream
status become available. If the browser fails while `curl` works, first check
`CORS_ALLOW_ORIGIN` and the Fleet Platform URL injected into Operator UI.

Verify the simulator connects through Fleet Platform state:

```sh
curl -fsS "$FLEET_PLATFORM_URL/robots/$ROBOT_ID"
```

The robot should show the simulator edge-agent version and an online or fresh
connection state after the simulator starts. If it does not, inspect simulator
logs and Fleet Platform edge gateway logs:

```sh
kubectl -n "$NAMESPACE" logs deploy/cloud-edge-simulator --tail=100
kubectl -n "$NAMESPACE" logs deploy/fleet-platform --tail=100
```

Verify event stream and API evidence:

```sh
curl -fsS "$FLEET_PLATFORM_URL/events"
curl -fsS "$FLEET_PLATFORM_URL/audit-events"
curl -fsS "$FLEET_PLATFORM_URL/metrics"
```

For live SSE evidence, run this briefly while creating or resetting a mission:

```sh
curl -N "$FLEET_PLATFORM_URL/stream/events"
```

Stop the SSE command after the relevant events appear.

## Evidence Capture Checklist

Capture enough evidence that a reviewer can understand both the incident flow
and the deployment boundary without live access.

- Operator UI reset state: show the demo robot after reset with no stale
  previous mission confusing the recording.
- Mission created/running: create a `GO_TO_POSE` mission and show dispatch,
  accepted acknowledgement, and running state.
- Map movement: record the virtual map as simulator telemetry moves the robot
  toward the target.
- Stale/degraded state: trigger stale telemetry and show the robot health or
  connection state degrading while the mission remains active.
- Reconnect/reconciliation: trigger reconnect and show the event timeline
  returning the mission to the reconciled state.
- Event timeline: capture the Operator UI timeline with command, telemetry,
  stale, reconnect, and reconciliation entries visible.
- Audit/event API snippets: save short outputs from `/events`,
  `/audit-events`, and a focused mission read when useful.
- Metrics endpoint: capture `/metrics` output that shows HTTP, edge, domain,
  audit, telemetry freshness, or readiness counters from this run.
- Kubernetes deployment evidence: capture namespace workloads, image refs,
  rollout status, pod readiness, and selected logs.
- ArgoCD deployment evidence, if applicable: capture application sync status,
  health status, source revision, and history.

Useful commands during capture:

```sh
curl -fsS "$FLEET_PLATFORM_URL/missions"
curl -fsS "$FLEET_PLATFORM_URL/events"
curl -fsS "$FLEET_PLATFORM_URL/audit-events"
curl -fsS "$FLEET_PLATFORM_URL/metrics"
kubectl -n "$NAMESPACE" rollout status deploy/fleet-platform
kubectl -n "$NAMESPACE" rollout status deploy/operator-ui
kubectl -n "$NAMESPACE" rollout status deploy/cloud-edge-simulator
kubectl -n "$NAMESPACE" get deploy,pod,svc -o wide
```

Keep screenshots and clips reviewer-oriented. Prefer a few clear artifacts over
a complete operations dump: UI incident flow, API evidence, metrics, and
Kubernetes/GitOps deployment proof.

## Teardown Checklist

Tear down the environment immediately after capture unless there is an active
reason to keep a reviewed URL available.

- Remove or disable public access at DNS, load balancer, ingress, security
  group, or reverse-proxy level.
- Scale down or delete demo workloads:

```sh
kubectl -n "$NAMESPACE" scale deploy/fleet-platform --replicas=0
kubectl -n "$NAMESPACE" scale deploy/operator-ui --replicas=0
kubectl -n "$NAMESPACE" scale deploy/cloud-edge-simulator --replicas=0
```

Or delete the short-lived namespace when nothing else shares it:

```sh
kubectl delete namespace "$NAMESPACE"
```

- Delete or rotate the demo token Secret and any provider-level access tokens
  used for the run.
- If ArgoCD managed the app, disable automated sync or delete the temporary
  Application so it does not recreate public workloads.
- Confirm no expensive AWS resources are left running, especially load
  balancers, NAT gateways, EKS node groups, persistent volumes, RDS instances,
  Elastic IPs, and snapshots.
- Record teardown evidence with `kubectl get namespace`, ArgoCD app status,
  or AWS console/CLI views as appropriate.

This teardown is part of the portfolio story: the demo is reproducible, bounded,
and intentionally short-lived.
