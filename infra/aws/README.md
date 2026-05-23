# AWS Fargate Cloud Reference

This folder contains the smallest AWS deployment reference for the RoboOps
cloud-side demo components:

- `apps/fleet-platform`
- `apps/operator-ui`

The reference stack uses ECS on Fargate behind one internet-facing Application
Load Balancer. It intentionally does not deploy Isaac Sim, the cloud-edge
simulator, Postgres, EKS, App Runner, or ArgoCD.

## Deployment Shape

`ecs-fargate-cloud.yml` creates:

- one ECS cluster;
- one HTTPS ALB with host-based routing;
- one Fleet Platform Fargate service on port `4010`;
- one Operator UI Fargate service on port `4020`;
- target-group health checks for `/health/ready` and `/health/live`;
- exact CORS wiring from Fleet Platform to the Operator UI origin;
- exact Operator UI API wiring to the Fleet Platform URL;
- CloudWatch log groups and minimal task roles.

Fleet Platform is pinned to one desired task. Its edge WebSocket connections
are process-local, so the service uses a one-at-a-time deployment configuration
instead of temporarily running two Fleet Platform tasks during updates.

The stack expects images to already exist, preferably in ECR for this AWS demo.
Build and push commands are in
[docs/aws-fargate-brev-isaac-runbook.md](../../docs/aws-fargate-brev-isaac-runbook.md).

## Required Inputs

- VPC id
- at least two public subnet ids
- ACM certificate ARN in the same region
- public Fleet Platform host name
- public Operator UI host name
- immutable Fleet Platform image URI
- immutable Operator UI image URI

If `HostedZoneId` is provided, the stack creates Route 53 alias records for both
host names. If it is blank, create DNS records manually to the ALB DNS output.

## Runtime Defaults

Fleet Platform uses in-memory persistence in this stack. That keeps the hosted
Isaac smoke slice small and matches the current process-local edge connection
constraint. State is lost when the task restarts or the stack is replaced.

Demo reset/fault controls are disabled by default. To enable them, set
`DemoMode=true` and pass a Secrets Manager ARN through
`DemoAdminTokenSecretArn`; do not put the token value in CloudFormation
parameters, shell history, or committed files.
