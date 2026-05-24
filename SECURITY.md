# Security Policy

## Supported Versions

This is a portfolio prototype. Only the current `main` branch is considered supported for review and demonstration purposes.

## Reporting a Security Issue

Please report suspected security issues privately to the repository owner rather than opening a public GitHub issue.

Include:

- a short description of the issue
- steps to reproduce it, if possible
- the affected area of the project
- any relevant logs or screenshots without secrets

## Demo and Token Boundaries

This project includes local/demo controls for reset, disconnect, stale telemetry, and reconnect scenarios.

Demo admin tokens are intended only for local or short-lived demo environments. They are not user authentication, should not be committed, and should be rotated or removed after use.

Do not commit:

- real robot credentials
- cloud provider credentials
- production database URLs
- private API keys
- long-lived demo tokens

## Robotics Safety Boundary

RoboOps Control Plane is not safety-certified, not production-ready, and not a robot safety system.

It must not be used to control real robots, safety-critical equipment, or production mission-control workflows without a separate safety architecture, threat model, validation process, and certification work where required.

## Scope

Security reports are most useful for issues involving:

- exposed secrets
- unsafe demo controls
- authentication or authorization mistakes
- WebSocket/API misuse
- dependency or container vulnerabilities
- documentation that could encourage unsafe deployment

General product ideas, feature requests, or roadmap discussions should use normal GitHub issues instead.
