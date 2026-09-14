# Architecture

## High-Level Overview

The application is split into a browser UI, a Node.js workflow server, and a Python scientific execution layer.

## Main Components

- `index.html`: unified SPA shell for search, review, environment, and workflow views.
- `js/spa-shell.js`: custom-element shell that renders the single-page workspace and switches between Search and Review views.
- `js/app.js`: cross-database search, selection persistence, and Search-view behavior.
- `review.html`: compatibility redirect into the Review view inside the SPA shell.
- `js/review.js`: workflow state management, saved-project recovery, backend polling, stage execution, and artifact actions.
- `server.js`: integrated static server and workflow API. It persists project state, handles saved project discovery, manages uploads, and launches stage jobs.
- `backend/md_pipeline.py`: Python execution backend for protein preparation, ligand preparation, complex assembly, solvation, ions, minimization, NVT, NPT, and production MD.

## Runtime Flow

1. The user opens the unified SPA shell on `index.html`.
2. The Search view writes the current search state and selected molecules into local storage.
3. The Review view builds and synchronizes the workflow project model in the browser.
4. When a stage is run, `server.js` persists project state and launches the Python backend when the stage is scientifically wired.
5. Stage logs, checkpoint metadata, and artifact paths are written back into project state.
6. The Review view polls the backend and exposes artifacts directly in the UI.

## Search Proxy Layer

The browser no longer talks directly to external search APIs.

- `server.js` now proxies search requests through local endpoints such as `POST /api/search`, `POST /api/search/pdb-details`, and `POST /api/search/pubchem-properties`.
- `js/app.js` still owns client-side result rendering and selection UX, but its remote fetches now go through the local server.
- This keeps the desktop runtime on a single controlled backend surface and removes browser-side CORS workarounds from the primary flow.

## Current Workflow Stage Coverage

Real backend execution is currently implemented for:

- import
- protein-prep
- ligand-prep
- complex-build
- solvation
- ions
- minimization
- nvt
- npt
- production

The `analysis` stage exists in the UI but is still a planning and reporting surface rather than a fully wired backend stage.

## Saved Project Recovery

The workflow page can now recover saved backend projects in three ways:

- automatic restore of the latest saved project when local selection state is empty
- explicit selection from the saved-project picker in the workflow header
- explicit recovery actions from the empty state on `review.html`

The backend exposes:

- `GET /api/workflow/projects/latest`
- `GET /api/workflow/projects`
- `GET /api/workflow/projects/<project-id>`

## Managed Runtime Layout

Runtime data is stored in:

```text
.runtime/workflow/projects/<project-id>/
```

Typical structure:

```text
project-state.json
imports/
stages/
  import/
  protein-prep/
  ligand-prep/
  complex-build/
  solvation/
  ions/
  minimization/
  nvt/
  npt/
  production/
```

## Key Backend Responsibilities

### `server.js`

- serve `index.html`, `review.html`, CSS, and JavaScript
- persist project state atomically
- maintain job history and stage logs
- manage pose and reference uploads
- discover saved projects
- recover from partial state writes using backup-aware state loading

### `backend/md_pipeline.py`

- repair proteins with PDBFixer
- generate ligand conformers with RDKit
- parameterize ligands with OpenFF and RDKit MMFF94 charges
- assemble protein-ligand complexes
- build solvated and ionized systems
- run minimization, NVT, NPT, and production trajectories with OpenMM

## Design Constraints To Keep In Mind

- This is a local pilot MD workflow, not a cluster scheduler.
- Production defaults should be treated as pilot-scale until longer validation has been added.
- Automatic ligand placement is a convenience path, not a docking replacement.
- The current search page is useful, but saved-project recovery is the most reliable way to resume validated work.