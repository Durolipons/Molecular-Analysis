# Project Documentation

This folder contains the working documentation for the Molecular Analysis Tool.

## Start Here

- [setup-and-run.md](./setup-and-run.md): install the Node.js and Python dependencies, start the server, and verify the local backend.
- [first-simulation.md](./first-simulation.md): detailed step-by-step instructions for running a first local pilot simulation.
- [workflow-reference.md](./workflow-reference.md): stage-by-stage reference for the workflow UI and its controls.
- [architecture.md](./architecture.md): component map, runtime data flow, and file layout.
- [troubleshooting.md](./troubleshooting.md): common problems, recovery steps, and validation commands.

## Recommended Reading Order

1. Read [setup-and-run.md](./setup-and-run.md).
2. Read [first-simulation.md](./first-simulation.md).
3. Use [workflow-reference.md](./workflow-reference.md) while you are running stages.
4. Use [troubleshooting.md](./troubleshooting.md) if a stage, page, or dependency behaves unexpectedly.
5. Read [architecture.md](./architecture.md) when you want to extend the software.

## Current Entry Points

- `http://127.0.0.1:8080/` or `http://127.0.0.1:8083/`: search page (`index.html`).
- `http://127.0.0.1:8080/review.html` or `http://127.0.0.1:8083/review.html`: workflow and runtime page (`review.html`).

Use the same port for both pages. If you start the integrated server with the default `npm start`, the port is `8080`. If you override `PORT`, use that port consistently for search, review, and API access.