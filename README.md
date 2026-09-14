# Molecular Analysis Tool

Windows-first molecular review and molecular-dynamics workflow software. The app combines a browser UI, an integrated Node.js workflow backend, and a Python scientific runner so protein and protein-ligand jobs can be prepared, executed, and inspected without manual file chasing.

## What It Does

- Search and review structures and compounds from AlphaFold, PDB, UniProt, PubChem, ChEMBL, and KEGG.
- Capture environment context such as pH, temperature, ionic strength, solvent, and cofactor notes.
- Run staged local workflows for import, protein preparation, ligand preparation, complex assembly, solvation, ion placement, minimization, NVT, NPT, and production MD.
- Persist per-stage jobs, logs, checkpoints, and artifacts under `.runtime/workflow/projects/<project-id>/`.
- Expose stage artifacts directly in the review UI so generated PDB, DCD, CSV, JSON, XML, SDF, and checkpoint files can be opened or exported.

## Documentation

Additional project documentation now lives under [docs/README.md](docs/README.md).

Recommended starting points:

- [docs/setup-and-run.md](docs/setup-and-run.md)
- [docs/first-simulation.md](docs/first-simulation.md)
- [docs/workflow-reference.md](docs/workflow-reference.md)

## Architecture

- `index.html`: search and selection landing page.
- `review.html`: workflow, environment profile, and runtime workspace.
- `js/review.js`: workflow orchestration, backend polling, and artifact actions.
- `server.js`: integrated static server plus workflow API and job state persistence.
- `backend/md_pipeline.py`: Python execution path for OpenMM, PDBFixer, RDKit, and OpenFF-backed stages.

The integrated server is the primary runtime path:

```bash
npm start
```

This serves the UI and the same-origin workflow API on port `8080` by default.

## Setup

### 1. Install the Node.js dependencies

```bash
npm install
```

### 2. Install the Python MD stack

Use Python 3.14 and install the scientific backend dependencies:

```bash
py -3 -m pip install -r requirements-md.txt
```

`requirements-md.txt` includes:

- OpenMM, PDBFixer, OpenMMForceFields, and RDKit.
- OpenFF Toolkit, OpenFF Units, OpenFF Utilities, OpenFF Interchange, and OpenFF force-field data from source.
- Supporting runtime packages used by the OpenFF ligand path.

### 3. Start the integrated application server

```bash
npm start
```

Open `http://127.0.0.1:8080` in a browser.

## Workflow Backend

When a stage runs, the Node backend creates a managed project workspace and launches the Python runner for scientific stages. Each stage records:

- execution status
- job id and timestamps
- recent logs
- checkpoint metadata
- artifact paths

Runtime data is written to:

```text
.runtime/workflow/projects/<project-id>/
```

Important files include:

- `project-state.json`: persisted stage state and job history.
- `project-manifest.json`: imported project manifest.
- `stages/<stage-id>/`: artifacts for each workflow stage.

## Real MD Stages

The current backend supports real local execution for:

- `protein-prep`: PDBFixer cleanup, missing atoms, hydrogens, and prepared protein export.
- `ligand-prep`: RDKit 3D coordinate generation plus OpenFF 2.2.1 ligand template validation using RDKit MMFF94 charges.
- `complex-build`: protein-only pass-through or protein-ligand assembly with managed provenance.
- `solvation`: box planning.
- `ions`: OpenMM solvent and ion placement.
- `minimization`: OpenMM energy minimization.
- `nvt`, `npt`, `production`: OpenMM trajectory-producing MD stages with DCD, CSV, final PDB, and restart checkpoints.

## Protein-Ligand Support

The local ligand parameterization path now uses:

- OpenFF 2.2.1 for small-molecule force-field parameters.
- RDKit-generated ligand conformers.
- RDKit MMFF94 partial charges as the compatible charge model on this Windows Python 3.14 runtime.

`complex-build` can now proceed past the old parameterization guardrail. If no docked or reference pose is present in the current project, the backend applies a clash-reducing heuristic ligand placement and records that decision in the assembly report. This is suitable for local pilot workflows, but the assembled complex should still be reviewed before long campaigns.

## UI Artifact Actions

The review page stage runtime panel now exposes direct artifact actions for generated files. Users can:

- open text-based outputs such as PDB, CSV, JSON, XML, and SDF in the browser
- export binary or text artifacts such as DCD trajectories and OpenMM checkpoints
- inspect checkpoint primary artifacts without navigating the runtime directory manually

## Validation Commands

Useful narrow validation commands during development:

```bash
node --check .\server.js
node --check .\js\review.js
py -3 -m py_compile .\backend\md_pipeline.py
```

## Current Limits

- The production defaults are still pilot-scale for local CPU execution.
- CGenFF and GAFF remain planning paths in the UI; the executable local ligand route is the OpenFF option.
- Automatic protein-ligand placement is a managed fallback, not a docking replacement.
