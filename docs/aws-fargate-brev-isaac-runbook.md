# AWS Fargate + Brev Isaac Runbook

This runbook deploys only the RoboOps cloud-side components to AWS and keeps
Isaac Sim on NVIDIA Brev:

- Fleet Platform: public HTTPS API, SSE, and `/edge/connect` WebSocket endpoint.
- Operator UI: public HTTPS browser console pointed at the hosted Fleet Platform.
- Brev Isaac sender: outbound WebSocket client using the existing Fleet Platform
  protocol.

The deployment path is ECS on Fargate behind an Application Load Balancer. It
does not use App Runner, EKS, hosted Isaac Sim, Postgres, or the cloud-edge
simulator.

## Why This Path

The smallest credible AWS path for this slice is a standard ECS/Fargate service
pair behind one HTTPS ALB:

- ALB supports native WebSocket upgrades for `/edge/connect`.
- ALB target groups still use HTTP health checks, so Fleet Platform health is
  checked through `/health/ready` rather than through the WebSocket endpoint.
- ECS/Fargate can run the existing Node images without Kubernetes.
- The stack can hard-pin Fleet Platform to one running task because edge
  connections and in-memory state are process-local.
- Host-based routing gives separate public HTTPS origins for Fleet Platform and
  Operator UI while sharing one load balancer.
- ECR image pushes avoid private GHCR pull credentials in ECS.

ECS Express Mode is useful for fast stateless web deployments, but this repo
needs explicit host names, exact CORS wiring, and a single-task Fleet Platform
constraint. The checked-in CloudFormation stack keeps those choices visible.

## Prerequisites

- AWS CLI authenticated to the target account.
- Docker with Buildx.
- Permission to create ECR repositories, IAM roles, CloudWatch log groups, ECS
  services, an ALB, target groups, security groups, and optional Route 53
  records.
- An AWS region with Fargate capacity.
- A VPC with at least two public subnets that route to an internet gateway.
- Two DNS names, for example:
  - `fleet-roboops.example.com`
  - `operator-roboops.example.com`
- An ACM certificate in the same region covering both DNS names.
- Brev Launchable with the existing Isaac ROS2 sidecar setup.

This stack assigns public IPs to Fargate tasks to keep the short-lived demo
small and avoid NAT gateways. The task security group only accepts inbound app
traffic from the ALB security group.

If this account has never used ECS services, create the ECS service-linked role
once. If it already exists, AWS returns an `InvalidInput` already-exists error
and no action is needed.

```sh
aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com
```

## Configure Local Variables

Run from the repository root:

```sh
export AWS_REGION=us-east-1
export STACK_NAME=roboops-cloud-demo
export ECR_PREFIX=roboops
export FLEET_PLATFORM_HOST=fleet-roboops.example.com
export OPERATOR_UI_HOST=operator-roboops.example.com
export ROBOT_ID=robot-a
export CPU_ARCHITECTURE=X86_64
export IMAGE_TAG=sha-$(git rev-parse --short=12 HEAD)
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REGISTRY=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
export FLEET_PLATFORM_IMAGE=$ECR_REGISTRY/$ECR_PREFIX/fleet-platform:$IMAGE_TAG
export OPERATOR_UI_IMAGE=$ECR_REGISTRY/$ECR_PREFIX/operator-ui:$IMAGE_TAG
```

Use `CPU_ARCHITECTURE=ARM64` only when the images are built and pushed for
Linux ARM64. The commands below build Linux AMD64 images for the default.

Select the VPC and public subnets:

```sh
aws ec2 describe-vpcs \
  --region "$AWS_REGION" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text
```

```sh
export VPC_ID=<vpc-id>
```

```sh
aws ec2 describe-subnets \
  --region "$AWS_REGION" \
  --filters Name=vpc-id,Values="$VPC_ID" Name=map-public-ip-on-launch,Values=true \
  --query 'Subnets[].SubnetId' \
  --output text
```

```sh
export PUBLIC_SUBNET_IDS=subnet-aaaa,subnet-bbbb
```

Use subnets from at least two Availability Zones.

## Create Or Select The ACM Certificate

If you already have a certificate in this region that covers both hosts, set:

```sh
export ACM_CERTIFICATE_ARN=<certificate-arn>
```

Otherwise request one:

```sh
export ACM_CERTIFICATE_ARN=$(aws acm request-certificate \
  --region "$AWS_REGION" \
  --domain-name "$FLEET_PLATFORM_HOST" \
  --subject-alternative-names "$OPERATOR_UI_HOST" \
  --validation-method DNS \
  --query CertificateArn \
  --output text)
```

Print the DNS validation records:

```sh
aws acm describe-certificate \
  --region "$AWS_REGION" \
  --certificate-arn "$ACM_CERTIFICATE_ARN" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' \
  --output table
```

Create those CNAME records in the authoritative DNS zone. Then wait:

```sh
aws acm wait certificate-validated \
  --region "$AWS_REGION" \
  --certificate-arn "$ACM_CERTIFICATE_ARN"
```

If the public zone is in Route 53 and you want the stack to create service alias
records, set:

```sh
export HOSTED_ZONE_ID=<route53-hosted-zone-id>
```

If DNS is managed elsewhere, leave it blank and create `A`/`AAAA` aliases or
`CNAME` records to the ALB DNS output after the stack is deployed:

```sh
export HOSTED_ZONE_ID=
```

## Build And Push Images

Create ECR repositories once:

```sh
aws ecr create-repository \
  --region "$AWS_REGION" \
  --repository-name "$ECR_PREFIX/fleet-platform" \
  --image-scanning-configuration scanOnPush=true
```

```sh
aws ecr create-repository \
  --region "$AWS_REGION" \
  --repository-name "$ECR_PREFIX/operator-ui" \
  --image-scanning-configuration scanOnPush=true
```

If either command returns `RepositoryAlreadyExistsException`, keep going.

Authenticate Docker to ECR:

```sh
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ECR_REGISTRY"
```

Build and push Fleet Platform:

```sh
docker buildx build \
  --platform linux/amd64 \
  -f infra/container-images/Dockerfile \
  --build-arg APP_PACKAGE=@roboops/fleet-platform \
  -t "$FLEET_PLATFORM_IMAGE" \
  --push \
  .
```

Build and push Operator UI:

```sh
docker buildx build \
  --platform linux/amd64 \
  -f infra/container-images/Dockerfile \
  --build-arg APP_PACKAGE=@roboops/operator-ui \
  -t "$OPERATOR_UI_IMAGE" \
  --push \
  .
```

The GitHub Actions GHCR flow still builds the same app matrix. ECR is used here
only to keep the AWS runtime pull path simple.

## Optional Demo Token

Mission creation does not require demo mode. Enable demo mode only when you need
hosted reset/fault controls.

Create the token outside the repo:

```sh
aws secretsmanager create-secret \
  --region "$AWS_REGION" \
  --name "$STACK_NAME/demo-admin-token" \
  --secret-string '<high-entropy-token>'
```

```sh
export DEMO_MODE=true
export DEMO_ADMIN_TOKEN_SECRET_ARN=$(aws secretsmanager describe-secret \
  --region "$AWS_REGION" \
  --secret-id "$STACK_NAME/demo-admin-token" \
  --query ARN \
  --output text)
```

Leave these unset for the normal hosted Isaac smoke:

```sh
export DEMO_MODE=false
export DEMO_ADMIN_TOKEN_SECRET_ARN=
```

## Deploy Or Update AWS Resources

Deploy the stack:

```sh
aws cloudformation deploy \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --template-file infra/aws/ecs-fargate-cloud.yml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    PublicSubnetIds="$PUBLIC_SUBNET_IDS" \
    AcmCertificateArn="$ACM_CERTIFICATE_ARN" \
    HostedZoneId="$HOSTED_ZONE_ID" \
    FleetPlatformHostName="$FLEET_PLATFORM_HOST" \
    OperatorUiHostName="$OPERATOR_UI_HOST" \
    FleetPlatformImageUri="$FLEET_PLATFORM_IMAGE" \
    OperatorUiImageUri="$OPERATOR_UI_IMAGE" \
    RobotId="$ROBOT_ID" \
    CpuArchitecture="$CPU_ARCHITECTURE" \
    DemoMode="$DEMO_MODE" \
    DemoAdminTokenSecretArn="$DEMO_ADMIN_TOKEN_SECRET_ARN"
```

Print outputs:

```sh
aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output table
```

If `HOSTED_ZONE_ID` was blank, create DNS records now:

```text
$FLEET_PLATFORM_HOST  -> LoadBalancerDnsName
$OPERATOR_UI_HOST    -> LoadBalancerDnsName
```

Wait for services to stabilize:

```sh
aws ecs wait services-stable \
  --region "$AWS_REGION" \
  --cluster "$STACK_NAME-cluster" \
  --services fleet-platform operator-ui
```

## Verify Hosted Health

Set the public URLs:

```sh
export FLEET_PLATFORM_URL=https://$FLEET_PLATFORM_HOST
export OPERATOR_UI_ORIGIN=https://$OPERATOR_UI_HOST
```

Verify Fleet Platform:

```sh
curl -fsS "$FLEET_PLATFORM_URL/health/live"
```

```sh
curl -fsS "$FLEET_PLATFORM_URL/health/ready"
```

Verify Operator UI:

```sh
curl -fsS "$OPERATOR_UI_ORIGIN/health/live"
```

Verify that the edge endpoint is routed and requires a WebSocket upgrade:

```sh
curl -i "$FLEET_PLATFORM_URL/edge/connect?robotId=$ROBOT_ID"
```

Expected status is `426` with `WEBSOCKET_REQUIRED`.

Inspect target health:

```sh
export FLEET_TG_ARN=$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='FleetPlatformTargetGroupArn'].OutputValue" \
  --output text)
```

```sh
export OPERATOR_TG_ARN=$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='OperatorUiTargetGroupArn'].OutputValue" \
  --output text)
```

```sh
aws elbv2 describe-target-health \
  --region "$AWS_REGION" \
  --target-group-arn "$FLEET_TG_ARN" \
  --query 'TargetHealthDescriptions[].TargetHealth'
```

```sh
aws elbv2 describe-target-health \
  --region "$AWS_REGION" \
  --target-group-arn "$OPERATOR_TG_ARN" \
  --query 'TargetHealthDescriptions[].TargetHealth'
```

## Start The Brev Isaac Sender

Keep Isaac Sim running on the Brev Launchable. The sender runs from the
RoboOps `ros2-probe` sidecar, which is not part of the upstream Isaac
Launchable until the local override is installed.

From the Brev host, make sure the RoboOps checkout exists and install the
sidecar override:

```sh
cd ~
[ -d RoboOps-Control-Plane/.git ] || git clone https://github.com/reinhard-z/RoboOps-Control-Plane.git RoboOps-Control-Plane
bash ~/RoboOps-Control-Plane/sim/isaac-sim/launchable/configure-ros2-probe-sidecar.sh
```

Then move to the Launchable compose project:

```sh
cd ~/isaac-launchable/isaac-lab
```

Validate hosted Fleet Platform from inside the ROS2 sidecar:

```sh
docker compose --profile probe run --rm ros2-probe bash -lc 'curl -fsS -m 10 https://fleet-roboops.example.com/health/live'
```

Start the live sender. Replace the URL with your actual Fleet Platform host:

```sh
docker compose --profile probe run --rm ros2-probe bash -lc 'source /opt/ros/humble/setup.bash && FLEET_PLATFORM_URL=https://fleet-roboops.example.com ISAAC_EDGE_ROBOT_ID=robot-a ISAAC_EDGE_HEARTBEAT_SECONDS=1 bash /roboops/sim/isaac-sim/scripts/send-odom-telemetry-edge.sh'
```

Expected Brev log evidence:

- `connected to Fleet Platform edge socket`
- `sent edge.telemetry eventId=...`
- `sent edge.command_ack commandId=... status=ACCEPTED`
- `started /cmd_vel motion plan`
- `publishing /cmd_vel`

## Create GO_TO_POSE From Hosted Operator UI

Open:

```text
https://operator-roboops.example.com
```

Use the `GO_TO_POSE` form and create a target such as:

```text
X: 2
Y: 4.5
Theta: 1.57
```

The browser should show:

- API status connected;
- SSE stream connected;
- robot `ONLINE` or fresh telemetry;
- mission state advancing to `RUNNING` after the edge ack;
- the virtual map moving as Isaac odometry changes.

For API evidence while the UI is open:

```sh
curl -fsS "$FLEET_PLATFORM_URL/robots/$ROBOT_ID"
```

```sh
curl -fsS "$FLEET_PLATFORM_URL/missions"
```

```sh
curl -fsS "$FLEET_PLATFORM_URL/events"
```

For live event evidence:

```sh
curl -N "$FLEET_PLATFORM_URL/stream/events"
```

Stop the SSE command after the mission dispatch, ack, and telemetry events are
visible.

## Troubleshooting

If Fleet Platform health is `503`, inspect logs:

```sh
aws logs tail "/ecs/$STACK_NAME/fleet-platform" \
  --region "$AWS_REGION" \
  --since 10m
```

If Operator UI loads but browser calls fail, verify:

```sh
curl -fsS "$FLEET_PLATFORM_URL/health/ready"
```

Then confirm Fleet Platform was deployed with:

```text
CORS_ALLOW_ORIGIN=https://$OPERATOR_UI_HOST
```

If the Brev sender does not connect, confirm the sidecar can reach HTTPS health
and that the sender uses the base URL only:

```text
FLEET_PLATFORM_URL=https://$FLEET_PLATFORM_HOST
```

Do not append `/edge/connect`, `/health/live`, or a port.

If the edge connects but commands are not acknowledged, keep the sender terminal
visible and create another mission from the hosted UI. The sender must log the
incoming `platform.command`, an accepted `edge.command_ack`, and `/cmd_vel`
publishing.

## Teardown

Delete the stack after the evidence capture:

```sh
aws cloudformation delete-stack \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"
```

```sh
aws cloudformation wait stack-delete-complete \
  --region "$AWS_REGION" \
  --stack-name "$STACK_NAME"
```

Delete optional demo token secrets and old ECR images when no longer needed.
Confirm no ALB, Fargate services, NAT gateways, or public DNS records remain.

## AWS References

- Application Load Balancer WebSocket listener support:
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html
- Application Load Balancer idle timeout:
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html
- Application Load Balancer health checks:
  https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html
- ECS services with Application Load Balancers:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/alb.html
- ECS Express Mode overview:
  https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-overview.html
